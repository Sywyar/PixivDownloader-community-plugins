import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy, API_BYTES, repository } from './github.mjs';
import { hash } from './sdk.mjs';
import { git, pull } from './platform.mjs';
import { downloadCandidate, uploadCandidate } from './candidate-transfer.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { readBlob, repositoryTree, stateReader } from './submission-github.mjs';
import { submissionBranch } from './submission-write.mjs';
import { currentAdmission, mergedRequest, restoreReview } from './apply-context.mjs';
import { refreshIdentity } from './apply-generation.mjs';

export const receiptPath = requestId => {
    if (!/^[a-f0-9]{64}$/u.test(requestId)) throw new Error('APPLY_REQUEST_ID_INVALID');
    return `generated/receipts/${requestId}.json`;
};

export function receiptExpired(receipt, now = Date.now()) {
    const file = receipt.files.find(file => file.path === 'revocations.json');
    if (!file) throw new Error('APPLY_REVOCATIONS_MISSING');
    const nextUpdate = Date.parse(JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8')).nextUpdate);
    if (!Number.isFinite(nextUpdate)) throw new Error('APPLY_REVOCATIONS_INVALID');
    return nextUpdate <= now;
}

// 生成结果只有固定路径集合；普通投稿不能通过声明“生成结果”取得写入权限。
export function resultPath(file) {
    return /^(?:publishers\/[1-9][0-9]*\/[^/]+|plugin-bindings\/[^/]+|published\/[^/]+\/[^/]+|audits\/[a-f0-9]{64}|records\/[a-f0-9]{64}|reviews\/(?:evidence\/[a-f0-9]{64}|[^/]+\/[^/]+)|revocations\/restrictions|generated\/(?:current|community-key|receipts\/[a-f0-9]{64})|revocations)\.json$/u.test(file)
        || /^generated\/generations\/[1-9][0-9]*\/(?:(?:catalog|repository|revocations|directory)\.json(?:\.sig)?|shards\/[a-f0-9]{64}\.json)$/u.test(file)
        || /^(?:generated\/(?:catalog\.json(?:\.sig)?|repository\.json)|revocations\.json\.sig)$/u.test(file);
}

export function makeReceipt({ requestId, operation, pr, current, run, writes, state, releases, appliedAt, reviewContext }) {
    const files = [...writes].filter(([file, bytes]) => !state.raw(file)?.equals(bytes)).sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => {
        if (!resultPath(file) || file === receiptPath(requestId)) throw new Error('APPLY_WRITE_FORBIDDEN');
        const before = state.raw(file);
        if (before && /^(?:records|audits|published|reviews|generated\/generations)\//u.test(file) && !before.equals(bytes)) throw new Error('IMMUTABLE_RESULT_CONFLICT');
        return { path: file, size: bytes.length, sha256: hash(bytes), before: before ? hash(before) : null, bytes: bytes.toString('base64') };
    }).filter(file => file.before !== file.sha256);
    const value = { schemaVersion: 1, repositoryId: policy.repositoryId, requestId, operation, prNumber: pr?.number ?? null,
        headSha: pr ? sha(pr.head.sha) : null, mergeSha: pr ? sha(pr.merge_commit_sha) : null, baseSha: sha(current), runId: id(run.id),
        runAttempt: run.run_attempt, appliedAt, files, releases, reviewContext };
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
    return { value, bytes };
}

export async function immutableAsset(releaseId, file, name, { call = api, download = downloadCandidate, upload = uploadCandidate } = {}) {
    const bytes = fs.readFileSync(file);
    const matches = list(`${prefix}/releases/${id(releaseId)}/assets`, null, call).filter(asset => asset.name === name);
    if (matches.length > 1) throw new Error('PUBLICATION_ASSET_DUPLICATED');
    let asset = matches[0];
    if (!asset) {
        try { asset = upload(releaseId, file, name); }
        catch (error) {
            const recovered = list(`${prefix}/releases/${id(releaseId)}/assets`, null, call).filter(asset => asset.name === name);
            if (recovered.length !== 1) throw error;
            asset = recovered[0];
        }
    }
    if (asset.state !== 'uploaded' || asset.size !== bytes.length || asset.digest !== `sha256:${hash(bytes)}`) throw new Error('PUBLICATION_ASSET_CONFLICT');
    const directory = fs.mkdtempSync(path.join(path.dirname(file), 'readback-'));
    await download(`${prefix}/releases/assets/${id(asset.id)}`, path.join(directory, 'asset'), bytes.length,
        { size: bytes.length, sha256: hash(bytes) });
    return asset;
}

export async function readReceipt(sdk, pointer, current, { call = api, readGit = git, download = downloadCandidate, verify = verifyPublicationProof } = {}) {
    if (pointer.schemaVersion !== 1 || !Number.isSafeInteger(pointer.size) || pointer.size < 1 || pointer.size > API_BYTES
        || !/^[a-f0-9]{64}$/u.test(pointer.sha256)) throw new Error('APPLY_RECEIPT_INVALID');
    const release = call(`${prefix}/releases/${id(pointer.releaseId)}`);
    const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
    const directory = fs.mkdtempSync(path.join(sdk.workspace, 'publication-'));
    const files = [];
    for (const name of ['publication.json', 'publication-attestation.json']) {
        const matches = assets.filter(asset => asset.name === name);
        if (matches.length !== 1 || matches[0].state !== 'uploaded' || !Number.isSafeInteger(matches[0].size)
            || matches[0].size < 1 || matches[0].size > API_BYTES || !/^sha256:[a-f0-9]{64}$/u.test(matches[0].digest)) throw new Error('APPLY_PROOF_MISSING');
        const asset = matches[0], file = path.join(directory, name);
        if (name === 'publication.json' && (asset.size !== pointer.size || asset.digest !== `sha256:${pointer.sha256}`)) throw new Error('APPLY_RECEIPT_CHANGED');
        await download(`${prefix}/releases/assets/${id(asset.id)}`, file, API_BYTES, { size: asset.size, sha256: asset.digest.slice(7) });
        files.push(file);
    }
    const certificate = verify(files[0], files[1], current, readGit);
    const receipt = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    if (receipt.schemaVersion !== 1 || receipt.repositoryId !== policy.repositoryId || receipt.baseSha !== certificate.sourceRepositoryDigest
        || release.tag_name !== `operation/${receipt.requestId}/${receipt.runId}-${receipt.runAttempt}`) throw new Error('APPLY_RECEIPT_INVALID');
    receiptPath(receipt.requestId);
    return receipt;
}

export async function checkResult(number, sdk, current, options = {}) {
    const { call = api } = options;
    const pr = pull(number, call), files = list(`${prefix}/pulls/${number}/files`, null, call);
    if (id(pr.user.id) !== policy.repositoryOwnerId || id(pr.head.repo.id) !== policy.repositoryId
        || files.length !== pr.changed_files || pr.state !== 'open' || pr.base.sha !== current) throw new Error('APPLY_RESULT_PR_INVALID');
    const pointers = files.filter(file => /^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file.filename));
    if (pointers.length !== 1 || pointers[0].status !== 'added'
        || files.some(file => !resultPath(file.filename) || !['added', 'modified'].includes(file.status) || file.previous_filename)) throw new Error('APPLY_WRITE_FORBIDDEN');
    const tree = repositoryTree(policy.repository, pr.head.sha, call);
    const bytes = file => readBlob(policy.repository, tree.get(file), call);
    const pointer = JSON.parse(bytes(pointers[0].filename).toString('utf8'));
    const receipt = await readReceipt(sdk, pointer, current, options);
    if (receiptExpired(receipt)) throw new Error('APPLY_RESULT_EXPIRED');
    if (receipt.baseSha !== current || receiptPath(receipt.requestId) !== pointers[0].filename
        || receipt.files.length + 1 !== files.length || new Set(receipt.files.map(file => file.path)).size !== receipt.files.length) throw new Error('APPLY_BASE_CHANGED');
    const baseTree = repositoryTree(policy.repository, current, call);
    for (const file of receipt.files) {
        if (!resultPath(file.path) || !files.some(row => row.filename === file.path)) throw new Error('APPLY_WRITE_FORBIDDEN');
        const expected = Buffer.from(file.bytes, 'base64');
        if (expected.toString('base64') !== file.bytes || expected.length !== file.size || hash(expected) !== file.sha256
            || !bytes(file.path).equals(expected)) throw new Error('APPLY_RESULT_CHANGED');
        const before = baseTree.has(file.path) ? hash(readBlob(policy.repository, baseTree.get(file.path), call)) : null;
        if (before !== file.before) throw new Error('APPLY_BASE_CHANGED');
    }
    const state = stateReader(sdk, current, call);
    if (receipt.operation === 'REFRESH') {
        if (receipt.prNumber !== null || receipt.headSha !== null || receipt.mergeSha !== null || receipt.releases.length
            || refreshIdentity(state) !== receipt.requestId || receipt.files.some(file => !/^(?:generated\/|records\/|revocations\.json(?:\.sig)?$)/u.test(file.path))) throw new Error('REFRESH_RESULT_INVALID');
    } else {
        const original = mergedRequest(receipt.prNumber, current, call, options.readGit);
        if (original.pr.head.sha !== receipt.headSha || original.pr.merge_commit_sha !== receipt.mergeSha) throw new Error('PUBLICATION_HEAD_CHANGED');
        currentAdmission(receipt.prNumber, sdk, { current }, restoreReview(sdk, state, receipt), call, options.readGit);
    }
    const after = pull(number, call);
    if (after.head.sha !== pr.head.sha || after.state !== pr.state || after.base.sha !== current
        || sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('PR_OR_BASE_CHANGED');
    return { receipt, pointer };
}

export function createResultPull(receipt, pointer, call = api) {
    repository(call, { owner: true, publicOnly: true });
    const current = () => sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha);
    if (current() !== receipt.baseSha) throw new Error('APPLY_BASE_CHANGED');
    const login = policy.repository.split('/')[0];
    const branch = submissionBranch({ actor: { id: policy.repositoryOwnerId, login } },
        `community/apply/${receipt.requestId}/${receipt.runId}-${receipt.runAttempt}`, call);
    const writes = new Map(receipt.files.map(file => [file.path, Buffer.from(file.bytes, 'base64')]));
    writes.set(receiptPath(receipt.requestId), Buffer.from(JSON.stringify(pointer) + '\n'));
    const tree = [];
    for (const [file, bytes] of writes) {
        const blob = call(`${prefix}/git/blobs`, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
        tree.push({ path: file, mode: '100644', type: 'blob', sha: sha(blob.sha) });
    }
    const parent = call(`${prefix}/git/commits/${receipt.baseSha}`);
    const created = call(`${prefix}/git/trees`, { method: 'POST', body: { base_tree: sha(parent.tree.sha), tree } });
    const message = `chore(community): 应用已审核的 ${receipt.operation} 请求\n\n- 固定请求 ${receipt.requestId}\n- 归档批准、签名和状态结果`;
    const identity = { name: 'Community publication', email: `${policy.repositoryOwnerId}+${login}@users.noreply.github.com`, date: receipt.appliedAt };
    const commit = call(`${prefix}/git/commits`, { method: 'POST', body: { message, tree: sha(created.sha), parents: [receipt.baseSha], author: identity, committer: identity } });
    if (current() !== receipt.baseSha) throw new Error('APPLY_BASE_CHANGED');
    const branchRefs = () => list(`${prefix}/git/matching-refs/heads/${branch}`, null, call).filter(ref => ref.ref === 'refs/heads/' + branch);
    const refs = branchRefs();
    if (refs.length > 1 || refs.length && refs[0].object.sha !== commit.sha) throw new Error('APPLY_BRANCH_CONFLICT');
    if (!refs.length) {
        try { call(`${prefix}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/' + branch, sha: sha(commit.sha) } }); }
        catch (error) { const recovered = branchRefs(); if (recovered.length !== 1 || recovered[0].object.sha !== commit.sha) throw error; }
    }
    const requests = () => list(`${prefix}/pulls?state=all&head=${encodeURIComponent(login + ':' + branch)}&base=${policy.defaultBranch}`, null, call);
    const matches = requests();
    if (matches.length > 1 || matches.length && (matches[0].head.sha !== commit.sha || matches[0].state !== 'open')) throw new Error('APPLY_PR_CONFLICT');
    let pr = matches[0];
    if (!pr) try { pr = call(`${prefix}/pulls`, { method: 'POST', body: { title: `chore(community): 应用 ${receipt.operation} 审核结果`,
        head: branch, base: policy.defaultBranch, draft: true,
        body: `${receipt.operation === 'REFRESH' ? '续签当前社区目录及撤销清单' : `应用请求 #${receipt.prNumber} 的已核验结果`}。原包和历史签名保持原始字节；本 PR 合并后整代状态生效。\n\n请求：${receipt.requestId}\n执行：https://github.com/${policy.repository}/actions/runs/${receipt.runId}` } });
    } catch (error) { const recovered = requests(); if (recovered.length !== 1) throw error; pr = recovered[0]; }
    const actual = pull(pr.number, call);
    if (!isDeepStrictEqual(actual.head.sha, commit.sha) || actual.state !== 'open' || actual.base.sha !== receipt.baseSha
        || id(actual.user.id) !== policy.repositoryOwnerId || id(actual.head.repo.id) !== policy.repositoryId) throw new Error('APPLY_PR_CONFLICT');
    if (current() !== receipt.baseSha) throw new Error('APPLY_BASE_CHANGED');
    return actual;
}
