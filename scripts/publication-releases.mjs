import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy } from './github.mjs';
import { hash } from './sdk.mjs';
import { downloadCandidate } from './candidate-transfer.mjs';
import { immutableAsset, readReceipt, checkResult, generatedParents } from './apply-result.mjs';
import { mergedRequest } from './apply-context.mjs';
import { applySdk } from './apply-sdk.mjs';
import { catalogId, prValue } from './platform.mjs';
import { stateReader } from './submission-github.mjs';
import { publisherPath } from './submission-check.mjs';
import { formalTag, packageName, encoded, releaseStatus } from './apply-generation.mjs';
export { releaseStatus };
import { download as publicDownload } from './download.mjs';
import { emergencyState } from './emergency-state.mjs';
import { archivedPackage, archiveRevokedPackage } from './revoked-packages.mjs';

function tagCommit(tag, call) {
    const refs = list(`${prefix}/git/matching-refs/tags/${tag}`, null, call).filter(ref => ref.ref === 'refs/tags/' + tag);
    if (!refs.length) return null;
    if (refs.length !== 1 || refs[0].object.type !== 'commit') throw new Error('PUBLICATION_TAG_CHANGED');
    return sha(refs[0].object.sha);
}

const assetIdentity = ({ id, name, size, digest, state }) => ({ id, name, size, digest, state });

export async function promoteReleases(completion, workspace, { call = api, download = downloadCandidate, fetch = publicDownload, confirm, authorize, ...transport } = {}) {
    const { receipt, pr, commit, merge } = completion;
    if (!pr?.merged || pr.state !== 'closed' || !merge || merge.sha !== pr.merge_commit_sha
        || commit?.sha !== pr.head.sha || !isDeepStrictEqual(commit.parents.map(parent => parent.sha), generatedParents(receipt))
        || !isDeepStrictEqual(merge.parents.map(parent => parent.sha), [receipt.baseSha, pr.head.sha])) throw new Error('REVIEW_MERGE_CHANGED');
    const targetCommit = sha(merge.sha);
    for (const expected of receipt.releases) {
        const directory = fs.mkdtempSync(path.join(workspace, 'promote-'));
        const read = () => {
            const release = call(`${prefix}/releases/${id(expected.id)}`);
            if (release.draft ? release.tag_name !== expected.originalTag || release.published_at !== null
                : release.tag_name !== expected.tag || release.target_commitish !== targetCommit) throw new Error('PUBLICATION_RELEASE_CHANGED');
            const assets = list(`${prefix}/releases/${id(expected.id)}/assets`, null, call);
            for (const original of expected.originalAssets) {
                const matches = assets.filter(asset => asset.name === original.name);
                if (matches.length !== 1 || !isDeepStrictEqual(assetIdentity(matches[0]), original)) throw new Error('PUBLICATION_ASSET_CHANGED');
            }
            const known = new Set([...expected.originalAssets.map(asset => asset.name), 'review.json', 'community-signature.json']);
            if (assets.some(asset => !known.has(asset.name))) throw new Error('PUBLICATION_ASSET_CHANGED');
            return { release, assets };
        };
        const initial = read();
        const artifact = initial.assets.find(asset => asset.name === expected.packageName);
        if (!artifact || artifact.size !== expected.packageSize || artifact.digest !== `sha256:${expected.packageSha256}`) throw new Error('PUBLICATION_PACKAGE_CHANGED');
        await download(`${prefix}/releases/assets/${id(artifact.id)}`, path.join(directory, 'package'), expected.packageSize,
            { size: expected.packageSize, sha256: expected.packageSha256 });
        if (typeof confirm !== 'function') throw new Error('PUBLICATION_CONFIRMATION_REQUIRED');
        await confirm(expected, path.join(directory, 'package'), completion);
        for (const [name, bytes] of [['review.json', Buffer.from(expected.reviewBytes, 'base64')], ['community-signature.json', encoded(expected.signature)]]) {
            const file = path.join(directory, name); fs.writeFileSync(file, bytes, { flag: 'wx' });
            await immutableAsset(expected.id, file, name, { call, download, ...transport });
        }
        const target = tagCommit(expected.tag, call);
        if (target && target !== targetCommit) throw new Error('PUBLICATION_TAG_CHANGED');
        const ready = read();
        if (ready.release.draft) {
            if (typeof authorize !== 'function') throw new Error('PUBLICATION_AUTHORIZATION_REQUIRED');
            await authorize(expected);
            const body = `Publisher: ${expected.owner.publisherId} (${expected.owner.accountType} ${expected.owner.accountId})\n`
                + `Source commit: ${expected.sourceCommit}\nSHA-256: ${expected.packageSha256}\nCommunity merge: ${targetCommit}`;
            try { call(`${prefix}/releases/${id(expected.id)}`, { method: 'PATCH', body: { tag_name: expected.tag,
                target_commitish: targetCommit, name: expected.name, body, draft: false,
                prerelease: /-(?:alpha|beta|rc)(?:\.?[0-9]+)?(?:\+.*)?$/u.test(expected.version), make_latest: 'false' } }); }
            catch (error) { if (call(`${prefix}/releases/${id(expected.id)}`).draft) throw error; }
        }
        const published = read();
        if (published.release.draft || !published.release.published_at || tagCommit(expected.tag, call) !== targetCommit) throw new Error('PUBLICATION_READBACK_FAILED');
        await fetch(`https://github.com/${policy.repository}/releases/download/${expected.tag}/${expected.packageName}`,
            path.join(directory, 'public-package'), expected.packageSize, { size: expected.packageSize, sha256: expected.packageSha256 });
    }
}

export function releaseBody(previous, { record, manager, status, sequence, review }) {
    const start = '<!-- community-publication-state:start -->', end = '<!-- community-publication-state:end -->';
    const section = `${start}\nState: ${status}\nCurrent maintainer: ${manager.publisherId} (${manager.accountType} ${manager.accountId})\n`
        + `Original publisher: ${record.owner.publisherId} (${record.owner.accountType} ${record.owner.accountId})\n`
        + `Publisher profile at review: https://github.com/${review.ownerLoginSnapshot}\nSource commit: ${record.sourceCommit}\n`
        + `Package SHA-256: ${record.package.sha256}\nReview SHA-256: ${record.reviewRef.sha256}\nGeneration: ${sequence}\n${end}`;
    const body = previous ?? '';
    const a = body.indexOf(start), b = body.indexOf(end);
    if ((a >= 0) !== (b >= 0) || a > b || a >= 0 && (body.indexOf(start, a + start.length) >= 0 || body.indexOf(end, b + end.length) >= 0)) throw new Error('RELEASE_STATE_SECTION_INVALID');
    const result = a < 0 ? `${body}\n\n${section}` : body.slice(0, a) + section + body.slice(b + end.length);
    if (Buffer.byteLength(result, 'utf8') > 65536) throw new Error('RELEASE_BODY_LIMIT');
    return result;
}

// completion 必须先经过原生合并、来源与完整生成树核验；本函数交 SDK 复验双签。
export function confirmPublication(sdk, state, record, file, completion) {
    const adapter = applySdk(sdk);
    const review = JSON.parse(state.reference(record.reviewRef));
    // 预算按本版本证据计算，不把整个目录的历史包证据累加进本次验签。
    for (const ref of [record.submissionRef, record.reviewRef, record.historicalPublisherRef,
        review.sourceDiffRef, review.sbomRef, review.dependencyReportRef, review.licenseReportRef,
        review.rebuildProofRef, review.riskScan.reportRef, review.humanReview.evidenceRef,
        review.publicationApprovalRef, ...review.riskScan.decisionRefs]) adapter.archive(state.reference(ref), ref.path);
    const publication = adapter.archive(state.raw(`published/${record.pluginId}/${record.version}.json`));
    const publisher = adapter.archive(state.raw(`publishers/${record.owner.accountId}/${record.owner.publisherId}.json`));
    fs.copyFileSync(file, path.join(adapter.workspace, 'package'), fs.constants.COPYFILE_EXCL);
    return adapter.invoke({ command: 'confirm-publication', communityKey: JSON.parse(state.raw('generated/community-key.json')),
        repositoryId: catalogId, published: publication, publisher, packageFile: 'package',
        merge: { pr: { ...prValue(completion.pr), baseSha: completion.receipt.baseSha }, generatedHead: completion.commit.sha,
            generatedParents: completion.commit.parents.map(parent => parent.sha), mergeParents: completion.merge.parents.map(parent => parent.sha), preparedRecord: publication } });
}

export async function finalizeReleases(context, sdk, { call = api, readGit, download = downloadCandidate, verify, write = true, ...transport } = {}) {
    const state = stateReader(sdk, context.current, call);
    const bytes = state.raw('generated/current.json');
    if (!bytes) return { applied: false };
    const current = JSON.parse(bytes.toString('utf8'));
    for (const ref of [current.descriptor, current.directory, current.catalog]) state.reference(ref);
    // 只以已进入主线的不可变结果为完成证据；未合并 Draft 不参与状态投影。
    const pointers = [...state.tree.keys()].filter(file => /^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file));
    const completions = [];
    for (const file of pointers) {
        const options = { call, readGit, download, ...(verify ? { verify } : {}) };
        const pointer = JSON.parse(state.raw(file).toString('utf8'));
        const receipt = await readReceipt(sdk, pointer, context.current, options);
        mergedRequest(receipt.prNumber, context.current, call, readGit);
        const completion = await checkResult(receipt.prNumber, sdk, context.current, { ...options, merged: true });
        if (!isDeepStrictEqual(completion.pointer, pointer)) throw new Error('APPLY_RECEIPT_CHANGED');
        completions.push(completion);
    }
    const receipts = completions.map(row => row.receipt);
    for (const completion of completions) for (const file of completion.receipt.files.filter(file => file.path.startsWith('audits/'))) {
        const bytes = state.raw(file.path);
        if (!bytes || hash(bytes) !== file.sha256) throw new Error('AUDIT_REFERENCE_MISMATCH');
        const audit = sdk.document('AUDIT', bytes, file.path).value;
        if (audit.result === 'PREPARED') {
            const adapter = applySdk(sdk);
            adapter.invoke({ command: 'confirm-operation', audit: adapter.archive(bytes, file.path),
                pr: { ...prValue(completion.pr), baseSha: completion.receipt.baseSha },
                generatedParents: completion.commit.parents.map(parent => parent.sha),
                mergeParents: completion.merge.parents.map(parent => parent.sha) });
        }
    }
    const revocations = JSON.parse(state.reference(current.revocations).toString('utf8'));
    const versions = [...state.tree.keys()].filter(file => /^published\/[^/]+\/[^/]+\.json$/u.test(file));
    let pending = false;
    for (const file of versions) {
        const record = state.read(file, 'PUBLISHED').value;
        const sources = completions.filter(row => row.receipt.releases.some(release => release.tag === formalTag(record)));
        const original = receipts.flatMap(receipt => receipt.releases).filter(release => release.tag === formalTag(record));
        if (sources.length !== 1 || original.length !== 1) throw new Error('PUBLICATION_RELEASE_CHANGED');
        const completion = sources[0];
        let release = call(`${prefix}/releases/${id(original[0].id)}`);
        if (release.draft) {
            if (!write) { pending = true; continue; }
            await promoteReleases(completion, sdk.workspace, { call, download, ...transport, authorize: () => {
                const publisher = sdk.document('PUBLISHER', state.reference(record.historicalPublisherRef), publisherPath(record.owner)).value;
                const key = publisher.signingKeys.find(key => key.keyId === record.package.signature.keyId);
                if (!key) throw new Error('PUBLICATION_KEY_MISSING');
                const emergency = emergencyState(sdk, call);
                emergency.requireKey(key);
                emergency.unchanged();
                if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
            }, confirm: (expected, file) => {
                if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
                return confirmPublication(sdk, state, record, file, completion);
            } });
            release = call(`${prefix}/releases/${id(original[0].id)}`);
        }
        if (release.tag_name !== formalTag(record) || release.draft
            || tagCommit(formalTag(record), call) !== completion.merge.sha) throw new Error('PUBLICATION_RELEASE_CHANGED');
        const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
        const status = releaseStatus(record, revocations);
        const storedPackage = status === 'REVOKED' ? archivedPackage(record, call) : null;
        for (const asset of original[0].originalAssets) {
            const matches = assets.filter(row => row.name === asset.name);
            if (!matches.length && asset.name === packageName(record) && storedPackage) continue;
            if (matches.length !== 1 || !isDeepStrictEqual(assetIdentity(matches[0]), asset)) throw new Error('PUBLICATION_ASSET_CHANGED');
        }
        const expected = assets.filter(asset => asset.name === packageName(record));
        if (!(expected.length === 0 && storedPackage) && (expected.length !== 1 || expected[0].state !== 'uploaded' || expected[0].size !== record.package.expectedSize
            || expected[0].digest !== `sha256:${record.package.sha256}`)) throw new Error('PUBLICATION_PACKAGE_CHANGED');
        const review = JSON.parse(state.reference(record.reviewRef).toString('utf8'));
        for (const [name, bytes] of [['review.json', state.reference(record.reviewRef)], ['community-signature.json', encoded(record.communitySignature)]]) {
            const matches = assets.filter(asset => asset.name === name);
            if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== bytes.length
                || matches[0].digest !== `sha256:${hash(bytes)}`) throw new Error('PUBLICATION_ASSET_CHANGED');
        }
        const manager = state.read(`plugin-bindings/${record.pluginId}.json`, 'BINDING').value.owner;
        const name = `${record.owner.publisherId} / ${record.pluginId}-v${record.version}${status === 'ACTIVE' ? '' : ` [${status}]`}`;
        const body = releaseBody(release.body, { record, manager, status, sequence: current.sequence, review });
        if (release.name !== name || release.body !== body) {
            if (!write) { pending = true; continue; }
            if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
            try { call(`${prefix}/releases/${id(release.id)}`, { method: 'PATCH', body: { name, body } }); }
            catch (error) { const actual = call(`${prefix}/releases/${id(release.id)}`); if (actual.name !== name || actual.body !== body) throw error; }
            const actual = call(`${prefix}/releases/${id(release.id)}`);
            if (actual.name !== name || actual.body !== body || actual.tag_name !== release.tag_name || actual.draft) throw new Error('RELEASE_STATUS_READBACK_FAILED');
        }
        if (status === 'REVOKED' && expected.length) {
            if (!write) pending = true;
            else await archiveRevokedPackage(context.current, record, release.id, expected[0], sdk.workspace, { call, download, ...transport });
        }
    }
    if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
    return { applied: !pending, sequence: current.sequence, receipts };
}
