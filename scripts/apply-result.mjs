import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { api, id, sha, list, prefix, policy, API_BYTES, repository } from './github.mjs';
import { hash } from './sdk.mjs';
import { git, pull, protectedSource } from './platform.mjs';
import { downloadCandidate, uploadCandidate } from './candidate-transfer.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { readBlob, repositoryTree, stateReader, requestTree } from './submission-github.mjs';
import { signedOwnerOperations } from './status-authorization.mjs';
import { reference, hydrateReceipt, originalReceipt, readReferencedBlob, receiptProofs, legacyPath, verifyBytes } from './receipt-storage.mjs';

export const receiptPath = requestId => {
    if (!/^[a-f0-9]{64}$/u.test(requestId)) throw new Error('APPLY_REQUEST_ID_INVALID');
    return `generated/receipts/${requestId}.json`;
};

export function receiptExpired(receipt, now = Date.now()) {
    if (receipt.recordOnly) return !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= now;
    const file = receipt.files.find(file => file.path === 'revocations.json');
    if (!file) throw new Error('APPLY_REVOCATIONS_MISSING');
    const nextUpdate = Date.parse(JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8')).nextUpdate);
    if (!Number.isFinite(nextUpdate)) throw new Error('APPLY_REVOCATIONS_INVALID');
    return nextUpdate <= now;
}

// 生成结果只有固定路径集合；普通投稿不能通过声明“生成结果”取得写入权限。
export function resultPath(file) {
    if (/^generated\/proofs\/[a-f0-9]{64}\.json$/u.test(file)) return true;
    return /^(?:publishers\/[1-9][0-9]*\/[^/]+|plugin-bindings\/[^/]+|published\/[^/]+\/[^/]+|audits\/[a-f0-9]{64}|records\/[a-f0-9]{64}|reviews\/(?:evidence\/[a-f0-9]{64}|[^/]+\/[^/]+)|revocations\/restrictions|generated\/(?:current|community-key|receipts\/[a-f0-9]{64})|revocations)\.json$/u.test(file)
        || /^generated\/generations\/[1-9][0-9]*\/(?:(?:catalog|repository|revocations|directory)\.json(?:\.sig)?|shards\/[a-f0-9]{64}\.json)$/u.test(file)
        || /^(?:generated\/(?:catalog\.json(?:\.sig)?|repository\.json)|revocations\.json\.sig)$/u.test(file);
}

export function makeReceipt({ requestId, operation, pr, current, run, writes, state, releases, appliedAt, reviewContext, inputFiles, recordOnly = false, authorization, previousHead }) {
    if (authorization !== undefined && (authorization !== 'SIGNED_OWNER' || !signedOwnerOperations.includes(operation) || recordOnly)) throw new Error('APPLY_RECEIPT_INVALID');
    if (previousHead && (operation === 'RENEWAL' || [pr.head.sha, current].includes(previousHead))) throw new Error('APPLY_RECEIPT_INVALID');
    const files = [...writes].filter(([file, bytes]) => !state.raw(file)?.equals(bytes)).sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => {
        if (!resultPath(file) || file === receiptPath(requestId)) throw new Error('APPLY_WRITE_FORBIDDEN');
        const before = state.raw(file);
        if (before && /^(?:records|audits|published|reviews|generated\/generations)\//u.test(file) && !before.equals(bytes)) throw new Error('IMMUTABLE_RESULT_CONFLICT');
        return { path: file, ...reference(bytes), before: before ? hash(before) : null, bytes: bytes.toString('base64') };
    }).filter(file => file.before !== file.sha256);
    if (!pr || pr.state !== 'open' || pr.merged || pr.draft || pr.base.sha !== current) throw new Error('REVIEW_OPEN_REQUEST_REQUIRED');
    const value = { schemaVersion: 3, repositoryId: policy.repositoryId, requestId, operation, prNumber: pr.number,
        headSha: sha(pr.head.sha), baseSha: sha(current), runId: id(run.id), ...(authorization === undefined ? {} : { authorization }),
        sourceSha: sha(run.sourceSha ?? current), integratedBase: operation !== 'RENEWAL',
        ...(previousHead ? { previousHead: sha(previousHead) } : {}),
        runAttempt: run.run_attempt, appliedAt, files, releases, reviewContext, originalPr: pr, inputFiles, recordOnly,
        expiresAt: new Date(Date.parse(appliedAt) + 30 * 24 * 60 * 60 * 1000).toISOString() };
    const bytes = originalReceipt(value);
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

export async function readReceipt(sdk, pointer, current, { call = api, readGit = git, download = downloadCandidate, verify = verifyPublicationProof,
    repositoryName = policy.repository } = {}) {
    if (pointer.schemaVersion === 2) {
        const directory = fs.mkdtempSync(path.join(sdk.workspace, 'publication-'));
        const [manifest, bundle] = receiptProofs(pointer).map(([name, ref]) => {
            const file = path.join(directory, path.basename(name));
            fs.writeFileSync(file, readReferencedBlob(ref, call, repositoryName), { flag: 'wx' });
            return file;
        });
        const certificate = verify(manifest, bundle, current, readGit);
        const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (value.schemaVersion !== 3 || value.repositoryId !== policy.repositoryId || (value.sourceSha ?? value.baseSha) !== certificate.sourceRepositoryDigest
            || !Array.isArray(value.files) || value.files.some(file => file.bytes !== undefined)) throw new Error('APPLY_RECEIPT_INVALID');
        receiptPath(value.requestId);
        if (value.sourceSha) protectedSource(sha(value.sourceSha), sha(value.baseSha), readGit);
        return hydrateReceipt(value, ref => readReferencedBlob(ref, call, repositoryName));
    }
    if (pointer.schemaVersion !== 1 || !Number.isSafeInteger(pointer.size) || pointer.size < 1 || pointer.size > API_BYTES
        || !/^[a-f0-9]{64}$/u.test(pointer.sha256)) throw new Error('APPLY_RECEIPT_INVALID');
    const migrated = legacyPath(pointer.sha256);
    const object = readGit(['ls-tree', '--format=%(objectname) %(objectsize)', sha(current), '--', migrated]).trim();
    if (object) {
        const [objectId, size] = object.split(' ');
        const projection = JSON.parse(readBlob(policy.repository, { sha: sha(objectId), size: Number(size), type: 'blob', mode: '100644' }, call));
        const receipt = hydrateReceipt(projection.receipt, ref => readReferencedBlob(ref, call));
        const bytes = verifyBytes(originalReceipt(receipt), pointer);
        const directory = fs.mkdtempSync(path.join(sdk.workspace, 'publication-'));
        const manifest = path.join(directory, 'publication.json'), bundle = path.join(directory, 'publication-attestation.json');
        fs.writeFileSync(manifest, bytes, { flag: 'wx' });
        fs.writeFileSync(bundle, readReferencedBlob(projection.attestation, call), { flag: 'wx' });
        const certificate = verify(manifest, bundle, current, readGit);
        if (receipt.schemaVersion !== 2 || receipt.repositoryId !== policy.repositoryId || receipt.baseSha !== certificate.sourceRepositoryDigest) throw new Error('APPLY_RECEIPT_INVALID');
        receiptPath(receipt.requestId);
        return { ...receipt, files: receipt.files.map(({ blob, ...file }) => file) };
    }
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
    if (receipt.schemaVersion !== 2 || receipt.repositoryId !== policy.repositoryId || receipt.baseSha !== certificate.sourceRepositoryDigest
        || release.tag_name !== `operation/${receipt.requestId}/${receipt.runId}-${receipt.runAttempt}`) throw new Error('APPLY_RECEIPT_INVALID');
    receiptPath(receipt.requestId);
    return receipt;
}

// 只在受保护归档、精确树差异和真实父链都核验后，读取原 head 的审核事实。
export function reviewedRequestCall(receipt, call = api) {
    return (endpoint, options = {}) => {
        if (options.method && options.method !== 'GET') throw new Error('READ_ONLY_CHECK');
        if (endpoint === `${prefix}/pulls/${receipt.prNumber}`) return structuredClone(receipt.originalPr);
        if (endpoint.split('?')[0] === `${prefix}/pulls/${receipt.prNumber}/files`) return [structuredClone(receipt.inputFiles)];
        return call(endpoint, options);
    };
}

export function reviewPrerequisite(pr, expectedHead, current) {
    if (pr.head.sha !== expectedHead) throw new Error('PUBLICATION_HEAD_CHANGED');
    if (pr.state !== 'open' || pr.merged || pr.draft) return 'REVIEW_OPEN_READY_PR_REQUIRED';
    if (id(pr.head.repo.id) !== policy.repositoryId && pr.maintainer_can_modify !== true) return 'MAINTAINER_EDITS_REQUIRED';
    return null;
}

export function forkApi(pr, call = api) {
    const name = pr.head.repo.full_name;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name)) throw new Error('GITHUB_TARGET_MISMATCH');
    const scoped = (endpoint, options = {}) => {
        const forkWrite = id(pr.head.repo.id) !== policy.repositoryId && options.method && options.method !== 'GET';
        if (forkWrite && !process.env.COMMUNITY_REVIEW_BRANCH_TOKEN) throw new Error('REVIEW_BRANCH_CREDENTIAL_REQUIRED');
        try {
            return call(endpoint, { ...options, repositoryName: name,
                ...(forkWrite ? { token: process.env.COMMUNITY_REVIEW_BRANCH_TOKEN } : {}) });
        } catch (error) {
            const status = Number(/\(HTTP ([1-5][0-9]{2})\)/u.exec(String(error.stderr ?? ''))?.[1]);
            if (forkWrite && [401, 403, 404].includes(status)) throw new Error('REVIEW_BRANCH_WRITE_DENIED');
            throw error;
        }
    };
    const repo = scoped(`repos/${name}`);
    if (id(repo.id) !== id(pr.head.repo.id) || repo.full_name !== name || repo.private || repo.archived
        || (id(repo.id) !== policy.repositoryId && (!repo.fork || id(repo.parent?.id) !== policy.repositoryId))) throw new Error('FORK_IDENTITY_CONFLICT');
    return scoped;
}

export function verifyGeneratedTree(receipt, pointer, parentTree, generatedTree, read) {
    const expected = new Map(receipt.files.map(file => [file.path, file]));
    if (expected.size !== receipt.files.length || expected.has(receiptPath(receipt.requestId))) throw new Error('APPLY_RECEIPT_INVALID');
    expected.set(receiptPath(receipt.requestId), { bytes: Buffer.from(JSON.stringify(pointer) + '\n').toString('base64'), before: null });
    for (const [file, ref] of receiptProofs(pointer)) {
        if (expected.has(file)) throw new Error('APPLY_RECEIPT_INVALID');
        if (generatedTree.get(file)?.mode !== '100644' || generatedTree.get(file)?.type !== 'blob') throw new Error('APPLY_WRITE_FORBIDDEN');
        const bytes = verifyBytes(read(generatedTree.get(file)), ref);
        if (parentTree.has(file)) {
            if (!read(parentTree.get(file)).equals(bytes)) throw new Error('APPLY_BASE_CHANGED');
            continue;
        }
        expected.set(file, { ...ref, before: null, bytes: bytes.toString('base64') });
    }
    const changed = [...new Set([...parentTree.keys(), ...generatedTree.keys()])].filter(file => {
        const a = parentTree.get(file), b = generatedTree.get(file);
        if (a?.type === 'tree' || b?.type === 'tree') return false;
        return a?.sha !== b?.sha || a?.mode !== b?.mode || a?.type !== b?.type;
    });
    if (changed.length !== expected.size || changed.some(file => !expected.has(file))) throw new Error('APPLY_WRITE_FORBIDDEN');
    for (const [file, record] of expected) {
        if (!resultPath(file) || generatedTree.get(file)?.mode !== '100644' || generatedTree.get(file)?.type !== 'blob') throw new Error('APPLY_WRITE_FORBIDDEN');
        const bytes = Buffer.from(record.bytes, 'base64');
        if (bytes.toString('base64') !== record.bytes || record.size !== undefined && (bytes.length !== record.size || hash(bytes) !== record.sha256)
            || !read(generatedTree.get(file)).equals(bytes)) throw new Error('APPLY_RESULT_CHANGED');
        const before = parentTree.has(file) ? hash(read(parentTree.get(file))) : null;
        if (before !== record.before) throw new Error('APPLY_BASE_CHANGED');
    }
}

export async function checkResult(number, sdk, current, options = {}) {
    const { call = api, readGit = git, merged = false, refresh = false } = options;
    const pr = pull(number, call), files = list(`${prefix}/pulls/${number}/files`, null, call);
    if (files.length !== pr.changed_files || (merged ? !pr.merged || pr.state !== 'closed' : pr.state !== 'open' || pr.merged)) throw new Error('APPLY_RESULT_PR_INVALID');
    const pointers = files.filter(file => /^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file.filename));
    if (pointers.length !== 1 || pointers[0].status !== 'added') throw new Error('APPLY_WRITE_FORBIDDEN');
    // 合并后的树从社区 Git 历史读取，不依赖投稿分支仍然存在。
    const scoped = merged ? call : forkApi(pr, call), name = merged ? policy.repository : pr.head.repo.full_name;
    const tree = repositoryTree(name, pr.head.sha, scoped);
    const pointer = JSON.parse(readBlob(name, tree.get(pointers[0].filename), scoped).toString('utf8'));
    const receipt = await readReceipt(sdk, pointer, current, { ...options, call: scoped, repositoryName: name });
    if (!merged) protectedSource(receipt.baseSha, current, readGit);
    if (!merged && !refresh && receiptExpired(receipt)) throw new Error('APPLY_RESULT_EXPIRED');
    const original = receipt.originalPr;
    if (!original || receipt.prNumber !== number || original.number !== number || original.state !== 'open' || original.merged || original.draft
        || original.head.sha !== receipt.headSha || original.base.sha !== receipt.baseSha
        || id(original.head.repo.id) !== id(pr.head.repo.id) || id(original.user.id) !== id(pr.user.id)
        || original.head.ref !== pr.head.ref || original.base.ref !== policy.defaultBranch
        || id(original.base.repo.id) !== policy.repositoryId || original.changed_files !== receipt.inputFiles?.length
        || receiptPath(receipt.requestId) !== pointers[0].filename || !merged && !refresh && receipt.baseSha !== current) throw new Error('APPLY_BASE_CHANGED');
    const commit = scoped(`repos/${name}/git/commits/${sha(pr.head.sha)}`);
    if (commit.sha !== pr.head.sha || !isDeepStrictEqual(commit.parents.map(parent => parent.sha), generatedParents(receipt))) throw new Error('REVIEW_PARENT_CHANGED');
    const headTree = repositoryTree(name, receipt.headSha, scoped);
    const parentTree = receipt.integratedBase ? requestTree(repositoryTree(name, receipt.baseSha, scoped), headTree, receipt.inputFiles) : headTree;
    verifyGeneratedTree(receipt, pointer, parentTree, tree, entry => readBlob(name, entry, scoped));
    let merge;
    if (merged) {
        merge = call(`${prefix}/git/commits/${sha(pr.merge_commit_sha)}`);
        if (merge.sha !== pr.merge_commit_sha || !isDeepStrictEqual(merge.parents.map(parent => parent.sha), [receipt.baseSha, pr.head.sha])) throw new Error('REVIEW_MERGE_CHANGED');
        readGit(['merge-base', '--is-ancestor', pr.merge_commit_sha, current]);
    }
    const after = pull(number, call);
    if (after.head.sha !== pr.head.sha || after.state !== pr.state || after.base.sha !== pr.base.sha
        || sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('PR_OR_BASE_CHANGED');
    return { receipt, pointer, pr, commit, merge, reviewCall: reviewedRequestCall(receipt, call) };
}

export const REVIEW_READBACK_ATTEMPTS = 5;
export const generatedParents = receipt => receipt.integratedBase
    ? [sha(receipt.headSha), sha(receipt.baseSha), ...(receipt.previousHead ? [sha(receipt.previousHead)] : [])] : [sha(receipt.headSha)];

export function requestSubject(receipt) {
    const checked = receipt.reviewContext?.checked;
    const publisher = (receipt.operation === 'OWNERSHIP_TRANSFER' ? checked?.from : checked?.owner)?.publisherId;
    const plugin = checked?.pluginId ?? checked?.submission?.pluginId;
    const version = checked?.version ?? checked?.submission?.version;
    return publisher && plugin ? `${publisher} / ${plugin}${version ? `-v${version}` : ''}${checked.to ? ` → ${checked.to.publisherId}` : ''}`
        : publisher ? `发布者 ${publisher}` : receipt.operation === 'RENEWAL' ? '社区撤销清单' : `PR #${receipt.prNumber}`;
}

export async function appendReviewCommit(receipt, pointer, call = api, { wait = delay, proofs = new Map() } = {}) {
    repository(call, { publicOnly: true });
    const current = () => sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha);
    if (current() !== receipt.baseSha) throw new Error('APPLY_BASE_CHANGED');
    const pr = pull(receipt.prNumber, call);
    const expectedHead = receipt.previousHead ?? receipt.headSha;
    const prerequisite = reviewPrerequisite(pr, expectedHead, receipt.baseSha);
    if (prerequisite) return { pending: prerequisite, pr };
    const scoped = forkApi(pr, call), target = `repos/${pr.head.repo.full_name}`;
    const writes = new Map(receipt.files.map(file => [file.path, Buffer.from(file.bytes, 'base64')]));
    for (const [file, ref] of receiptProofs(pointer)) writes.set(file, verifyBytes(proofs.get(file), ref));
    writes.set(receiptPath(receipt.requestId), Buffer.from(JSON.stringify(pointer) + '\n'));
    const tree = [];
    for (const [file, bytes] of writes) {
        if (!resultPath(file)) throw new Error('APPLY_WRITE_FORBIDDEN');
        const blob = scoped(`${target}/git/blobs`, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
        tree.push({ path: file, mode: '100644', type: 'blob', sha: sha(blob.sha) });
    }
    if (receipt.integratedBase) {
        const baseTree = repositoryTree(pr.head.repo.full_name, receipt.baseSha, scoped);
        const inputs = requestTree(baseTree, repositoryTree(pr.head.repo.full_name, receipt.headSha, scoped), receipt.inputFiles);
        for (const file of receipt.inputFiles) tree.push({ path: file.filename, mode: '100644', type: 'blob', sha: inputs.get(file.filename).sha });
    }
    const parent = scoped(`${target}/git/commits/${receipt.integratedBase ? receipt.baseSha : receipt.headSha}`);
    const created = scoped(`${target}/git/trees`, { method: 'POST', body: { base_tree: sha(parent.tree.sha), tree } });
    const subject = requestSubject(receipt);
    const message = `chore(community): ${receipt.authorization === 'SIGNED_OWNER' ? '处理已签名的' : '完成'} ${receipt.operation} 请求${receipt.authorization === 'SIGNED_OWNER' ? '' : '审核'}：${subject}\n\n- 固定请求 ${receipt.requestId}\n- 追加已验证的清单、签名和状态数据`;
    const identity = { name: 'Community review', email: `${policy.repositoryOwnerId}+${policy.repository.split('/')[0]}@users.noreply.github.com`, date: receipt.appliedAt };
    const commit = scoped(`${target}/git/commits`, { method: 'POST', body: { message, tree: sha(created.sha), parents: generatedParents(receipt), author: identity, committer: identity } });
    const before = pull(receipt.prNumber, call);
    if (current() !== receipt.baseSha || reviewPrerequisite(before, expectedHead, receipt.baseSha)) throw new Error('PUBLICATION_HEAD_CHANGED');
    // 普通快进更新：作者同时追加提交时 GitHub 拒绝，绝不强制覆盖投稿分支。
    const branch = () => sha(scoped(`${target}/git/ref/heads/${pr.head.ref}`).object.sha);
    try { scoped(`${target}/git/refs/heads/${pr.head.ref}`, { method: 'PATCH', body: { sha: sha(commit.sha), force: false } }); }
    catch (error) { if (branch() !== commit.sha) throw error; }
    // Git ref 已更新时，PR 视图仍可能短暂返回父提交；只回读，不再次写入。
    for (let attempt = 1; attempt <= REVIEW_READBACK_ATTEMPTS; attempt++) {
        const actual = pull(pr.number, call), ref = branch(), base = current();
        const details = JSON.stringify({ phase: 'review-commit-readback', expectedHead: commit.sha,
            actualHead: actual.head.sha, branchHead: ref, expectedBase: receipt.baseSha, actualBase: base, attempt });
        if (ref !== commit.sha || actual.state !== 'open' || actual.merged || actual.draft
            || ![pr.base.sha, receipt.baseSha].includes(actual.base.sha) || base !== receipt.baseSha
            || ![expectedHead, commit.sha].includes(actual.head.sha)) throw new Error('PUBLICATION_HEAD_CHANGED: ' + details);
        if (actual.head.sha === commit.sha) return { pr: actual, head: commit.sha };
        if (attempt === REVIEW_READBACK_ATTEMPTS) throw new Error('PUBLICATION_HEAD_NOT_VISIBLE: ' + details);
        await wait(1000);
    }
}
