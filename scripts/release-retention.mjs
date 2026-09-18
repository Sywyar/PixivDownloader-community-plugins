import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy, API_BYTES } from './github.mjs';
import { git } from './platform.mjs';
import { repositoryTree, readBlob } from './submission-github.mjs';
import { readReceipt } from './apply-result.mjs';
import { legacyPath } from './receipt-storage.mjs';
import { hash } from './sdk.mjs';

export const ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const assetsIdentity = values => values.map(({ id, name, state, size, digest }) => ({ id, name, state, size, digest }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
const timestamp = value => { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error('ARCHIVE_TIME_INVALID'); return result; };

// 只收集明确的引用；列表不完整、对象缺失或读取失败均中止清理。
export function releaseReferences(current, call = api) {
    const tree = repositoryTree(policy.repository, current, call), retained = new Map();
    const active = new Set(), requests = new Set();
    let total = 0;
    const read = (name, entry) => {
        const bytes = readBlob(name, entry, call);
        if ((total += bytes.length) > API_BYTES) throw new Error('STATE_SIZE_EXCEEDED');
        return bytes;
    };
    const pointers = (name, entries, opened = false) => {
        for (const [file, entry] of entries) if (/^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file)) {
            const pointer = JSON.parse(read(name, entry));
            if (pointer.schemaVersion === 1) {
                const releaseId = id(pointer.releaseId);
                if (retained.has(releaseId) && !isDeepStrictEqual(retained.get(releaseId), pointer)) throw new Error('APPLY_RECEIPT_CHANGED');
                retained.set(releaseId, pointer);
                if (opened) active.add(releaseId);
            }
            else if (pointer.schemaVersion !== 2) throw new Error('APPLY_RECEIPT_INVALID');
        }
    };
    pointers(policy.repository, tree);
    const published = new Map(retained);
    const open = list(`${prefix}/pulls?state=open&base=${policy.defaultBranch}`, null, call);
    for (const pr of open) {
        if (pr.state !== 'open' || pr.base?.ref !== policy.defaultBranch || id(pr.base.repo.id) !== policy.repositoryId) throw new Error('PR_TARGET_INVALID');
        const details = call(`${prefix}/pulls/${id(pr.number)}`);
        const files = list(`${prefix}/pulls/${id(pr.number)}/files`, null, call);
        if (details.head.sha !== pr.head.sha || files.length !== details.changed_files || new Set(files.map(file => file.filename)).size !== files.length) throw new Error('PR_FILES_INCOMPLETE');
        const entries = repositoryTree(pr.head.repo.full_name, sha(pr.head.sha), call);
        pointers(pr.head.repo.full_name, new Map(files.filter(file => entries.has(file.filename)).map(file => [file.filename, entries.get(file.filename)])), true);
        for (const file of files) if (/^(?:submissions|key-rotations|version-status-requests|ownership-transfers|renewals)\//u.test(file.filename)
            && entries.has(file.filename)) requests.add(hash(read(pr.head.repo.full_name, entries.get(file.filename))));
    }
    return { tree, published, retained, active, requests, open: open.map(pr => [pr.number, pr.head.sha]) };
}

export async function cleanupOperationArchives(current, releases, sdk, { call = api, readGit = git, now = Date.now(), ...transport } = {}) {
    const references = releaseReferences(current, call), result = { deleted: [], retained: [] };
    for (const release of releases) {
        const match = /^operation\/([a-f0-9]{64})\/([1-9][0-9]*)-([1-9][0-9]*)$/u.exec(release.tag_name);
        if (!match || release.draft !== true || release.published_at !== null) continue;
        const retain = reason => result.retained.push({ id: id(release.id), reason });
        if (references.active.has(id(release.id)) || references.requests.has(match[1])) { retain('OPEN_REQUEST'); continue; }
        const pointer = references.published.get(id(release.id));
        if (pointer && !references.tree.has(legacyPath(pointer.sha256))) { retain('GIT_PROOF_REQUIRED'); continue; }
        if (!pointer && references.retained.has(id(release.id))) { retain('OPEN_REQUEST'); continue; }
        const endpoint = `${prefix}/releases/${id(release.id)}`;
        const assets = list(`${endpoint}/assets`, null, call);
        const manifests = assets.filter(asset => asset.name === 'publication.json');
        if (manifests.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(manifests[0].digest)) { retain('ARCHIVE_INCOMPLETE'); continue; }
        const original = { schemaVersion: 1, releaseId: id(release.id), size: manifests[0].size, sha256: manifests[0].digest.slice(7) };
        if (pointer && !isDeepStrictEqual(pointer, original)) throw new Error('APPLY_RECEIPT_CHANGED');
        const receipt = await readReceipt(sdk, original, current, { call, readGit, ...transport });
        if (receipt.requestId !== match[1] || receipt.runId !== match[2] || String(receipt.runAttempt) !== match[3]) throw new Error('APPLY_RECEIPT_INVALID');
        const pr = call(`${prefix}/pulls/${id(receipt.prNumber)}`);
        const run = call(`${prefix}/actions/runs/${id(receipt.runId)}`);
        if (id(pr.number) !== id(receipt.prNumber) || id(pr.base.repo.id) !== policy.repositoryId || pr.base.ref !== policy.defaultBranch
            || id(run.id) !== id(receipt.runId) || id(run.repository.id) !== policy.repositoryId || run.run_attempt < receipt.runAttempt) throw new Error('ARCHIVE_SOURCE_CHANGED');
        if (pr.state !== 'closed' || run.status !== 'completed' || pr.merged && !pointer) { retain('REQUEST_OR_RUN_IN_USE'); continue; }
        const times = [release.updated_at, pr.closed_at, run.updated_at].map(timestamp);
        if (pointer) times.push(timestamp(readGit(['log', '-1', '--format=%cI', current, '--', legacyPath(pointer.sha256)])));
        if (now - Math.max(...times) < ARCHIVE_RETENTION_MS) { retain('RETENTION_PERIOD'); continue; }
        const fresh = releaseReferences(current, call);
        if (!isDeepStrictEqual([...references.retained], [...fresh.retained]) || !isDeepStrictEqual(references.open, fresh.open)
            || sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('APPLY_BASE_CHANGED');
        const actual = call(endpoint), latestPr = call(`${prefix}/pulls/${id(receipt.prNumber)}`), latestRun = call(`${prefix}/actions/runs/${id(receipt.runId)}`);
        if (['id', 'draft', 'published_at', 'tag_name', 'target_commitish', 'body', 'updated_at'].some(key => actual[key] !== release[key])
            || latestPr.state !== 'closed' || latestPr.merged !== pr.merged || latestPr.head.sha !== pr.head.sha
            || latestPr.closed_at !== pr.closed_at || latestRun.status !== 'completed' || latestRun.updated_at !== run.updated_at
            || !isDeepStrictEqual(assetsIdentity(assets), assetsIdentity(list(`${endpoint}/assets`, null, call)))) throw new Error('ARCHIVE_CHANGED');
        let failure;
        try { call(endpoint, { method: 'DELETE' }); } catch (error) { failure = error; }
        try { call(endpoint); }
        catch (error) {
            if (error.status !== 404 && !/\(HTTP 404\)/u.test(String(error.stderr ?? ''))) throw error;
            result.deleted.push(id(release.id)); continue;
        }
        throw failure ?? new Error('ARCHIVE_CLEANUP_NOT_CONFIRMED');
    }
    return result;
}
