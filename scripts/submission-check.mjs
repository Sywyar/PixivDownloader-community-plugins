import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hash } from './sdk.mjs';
import { download, httpsUrl } from './download.mjs';
import { checkedRepository, github } from './submission-github.mjs';

export const publisherPath = owner => `publishers/${owner.accountId}/${owner.publisherId}.json`;
export const bindingPath = pluginId => `plugin-bindings/${pluginId}.json`;
export const activeKey = publisher => {
    const keys = publisher.signingKeys.filter(key => key.state === 'ACTIVE');
    if (keys.length !== 1) throw new Error('PUBLISHER_ACTIVE_KEY_INVALID');
    return keys[0];
};
const same = (actual, expected, code) => { if (!isDeepStrictEqual(actual, expected)) throw new Error(code); };

export function versionAvailable(state, pluginId, version, digest) {
    const existing = state.published(pluginId).filter(row => row.value.version === version);
    if (existing.length > 1) throw new Error('PUBLISHED_VERSION_AMBIGUOUS');
    if (existing.length) {
        if (existing[0].value.package.sha256 !== digest) throw new Error('VERSION_DIGEST_CONFLICT');
        return existing[0];
    }
    if ([...state.tree.keys()].some(file => file.startsWith('submissions/') && file.endsWith(`/${pluginId}/${version}.json`))) {
        throw new Error('VERSION_SUBMISSION_OCCUPIED');
    }
    return null;
}

export function sourceLocation(source) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/u.exec(source.repository);
    if (!match || match[1].split('/').some(part => ['.', '..'].includes(part)) || !/^[a-f0-9]{40}$/u.test(source.commit)) {
        throw new Error('SOURCE_REPOSITORY_INVALID');
    }
    return { name: match[1], url: `${source.repository}/archive/${source.commit}.zip` };
}

export async function sourceArchive(sdk, source, projectDir, call = github, fetch = download) {
    const location = sourceLocation(source);
    if (source.archive.url !== location.url) throw new Error('SOURCE_ARCHIVE_LOCATION_INVALID');
    const repository = checkedRepository(location.name, call);
    const commit = call(`repos/${location.name}/commits/${source.commit}`);
    if (commit.sha !== source.commit) throw new Error('SOURCE_COMMIT_CHANGED');
    const file = path.join(sdk.workspace, `source-${crypto.randomUUID()}.zip`);
    await fetch(location.url, file, sdk.invoke({ command: 'limits' }).maxArchiveBytes, source.archive);
    const extracted = sdk.invoke({ command: 'source', file, projectDir });
    return { ...extracted, archiveFile: file, repositoryId: String(repository.id) };
}

// 候选只提供数据；身份、受保护状态、原始摘要和签名均重新读取并核对。
export async function validateChanges({ sdk, state, changes, user, authorize, call = github, fetch = download }) {
    if (!(changes instanceof Map) || !changes.size) throw new Error('SUBMISSION_EMPTY');
    const files = [...changes.keys()];
    for (const file of files) {
        sdk.invoke({ command: 'path', root: sdk.workspace, path: file, mustExist: false });
        if (state.tree.has(file)) throw new Error('APPEND_ONLY_REQUIRED');
        if (/-----BEGIN (?:ENCRYPTED |OPENSSH |RSA |EC )?PRIVATE KEY-----/u.test(changes.get(file).toString('utf8'))) throw new Error('PRIVATE_KEY_IN_SUBMISSION');
    }
    const allowed = new Set();
    const read = (file, kind) => {
        allowed.add(file);
        const bytes = changes.get(file);
        if (!bytes) throw new Error('SUBMISSION_FILE_MISSING');
        return { ...sdk.document(kind, bytes, file), bytes, path: file };
    };
    const currentPublisher = owner => {
        const record = state.read(publisherPath(owner), 'PUBLISHER');
        if (!record || record.value.githubAccount.id !== owner.accountId
            || record.value.githubAccount.type !== owner.accountType) throw new Error('PUBLISHER_IDENTITY_MISMATCH');
        return record;
    };
    const currentBinding = (pluginId, owner, digest) => {
        const record = state.read(bindingPath(pluginId), 'BINDING');
        if (!record || record.sha256 !== digest) throw new Error('BINDING_CHANGED');
        same(record.value.owner, owner, 'BINDING_CONFLICT');
        return record;
    };
    const proof = (record, kind, name, key) => sdk.invoke({ command: 'verify-proof', kind,
        file: sdk.save(record.bytes), proof: name, key });
    const authorizeOwner = owner => {
        if (user.type !== 'User' || !authorize(owner, user)) throw new Error('OWNER_AUTHORIZATION_REQUIRED');
    };
    const submissions = files.filter(file => file.startsWith('submissions/'));
    const rotations = files.filter(file => file.startsWith('key-rotations/'));
    const statuses = files.filter(file => file.startsWith('version-status-requests/'));
    const transfers = files.filter(file => file.startsWith('ownership-transfers/'));
    if ([submissions, rotations, statuses, transfers].filter(group => group.length).length !== 1) throw new Error('MIXED_OPERATION');
    let result;
    if (submissions.length) {
        if (submissions.length !== 1) throw new Error('SINGLE_VERSION_REQUIRED');
        const record = read(submissions[0], 'SUBMISSION');
        const value = record.value;
        const accountId = record.path.split('/')[1];
        const publisherFile = `publishers/${accountId}/${value.publisherId}.json`;
        const publisher = state.read(publisherFile, 'PUBLISHER') ?? read(publisherFile, 'PUBLISHER');
        const owner = { accountId, accountType: publisher.value.githubAccount.type, publisherId: value.publisherId };
        if (publisher.value.githubAccount.id !== accountId) throw new Error('PUBLISHER_IDENTITY_MISMATCH');
        authorizeOwner(owner);
        const binding = state.read(bindingPath(value.pluginId), 'BINDING');
        if (binding) same(binding.value.owner, owner, 'BINDING_CONFLICT');
        const previous = state.published(value.pluginId);
        if (previous.length && !binding) throw new Error('BINDING_MISSING');
        if (versionAvailable(state, value.pluginId, value.version, value.package.sha256)) throw new Error('VERSION_ALREADY_PUBLISHED');
        const previousCommit = previous[0]?.value.sourceCommit ?? null;
        same(value.source.previousReviewedCommit, previousCommit, 'PREVIOUS_SOURCE_CHANGED');
        httpsUrl(value.package.url);
        const source = await sourceArchive(sdk, value.source, value.buildProfile.projectDir, call, fetch);
        const images = [value.market.icon, ...(value.market.screenshots ?? [])].filter(Boolean);
        const imagesRoot = path.join(sdk.workspace, `images-${crypto.randomUUID()}`);
        fs.mkdirSync(imagesRoot);
        for (const image of images) {
            allowed.add(image.path);
            const bytes = changes.get(image.path);
            if (!bytes) throw new Error('MARKET_IMAGE_MISSING');
            const output = sdk.invoke({ command: 'path', root: imagesRoot, path: image.path, mustExist: false }).path;
            fs.mkdirSync(path.dirname(output), { recursive: true });
            if (!fs.existsSync(output)) fs.writeFileSync(output, bytes, { flag: 'wx' });
        }
        const extension = new URL(value.package.url).pathname.endsWith('.jar') ? '.jar' : '.zip';
        const artifact = path.join(sdk.workspace, crypto.randomUUID() + extension);
        await fetch(value.package.url, artifact, sdk.invoke({ command: 'limits' }).maxArchiveBytes,
            { size: value.package.expectedSize, sha256: value.package.sha256 });
        const verified = sdk.invoke({ command: 'verify', file: artifact, submission: sdk.save(record.bytes),
            publisher: sdk.save(publisher.bytes), publisherPath: publisherFile, path: record.path,
            previousReviewedCommit: previousCommit, sourceRoot: source.sourceRoot, imagesRoot });
        result = { operation: binding ? 'UPDATE' : 'FIRST_RELEASE', owner, pluginId: value.pluginId,
            version: value.version, publisherDisplayName: publisher.value.displayName,
            descriptor: verified.descriptor, sourceArchive: source.archiveFile,
            sourceRoot: source.sourceRoot, sourceRepositoryId: source.repositoryId, packageFile: artifact,
            submission: value, submissionPath: record.path, submissionSha256: record.sha256,
            bindingSha256: binding?.sha256 ?? hash(Buffer.from('null')), publisherSha256: publisher.sha256,
            package: { sha256: verified.sha256, size: verified.size }, publisherKeyFingerprint: verified.publisherKeyFingerprint };
    } else if (rotations.length) {
        if (rotations.length !== 1) throw new Error('SINGLE_ROTATION_REQUIRED');
        const record = read(rotations[0], 'ROTATION');
        const p = record.value.payload;
        const owner = { accountId: p.githubAccount.id, accountType: p.githubAccount.type, publisherId: p.publisherId };
        authorizeOwner(owner);
        const publisher = currentPublisher(owner);
        if (publisher.sha256 !== p.publisherRecordSha256 || activeKey(publisher.value).keyId !== p.oldKeyId) throw new Error('PUBLISHER_CHANGED');
        if (publisher.value.signingKeys.some(key => key.keyId === p.newKey.keyId || key.publicKeySpkiBase64 === p.newKey.publicKeySpkiBase64)) {
            throw new Error('ROTATION_KEY_REUSED');
        }
        proof(record, 'ROTATION', 'newKey', p.newKey);
        if (record.value.proofs.oldKey) proof(record, 'ROTATION', 'oldKey', activeKey(publisher.value));
        result = { operation: 'KEY_ROTATION', owner, requestId: record.value.requestId, requestPath: record.path,
            requestSha256: record.sha256, publisherSha256: publisher.sha256, recoveryRequired: !record.value.proofs.oldKey };
    } else if (statuses.length) {
        if (statuses.length !== 1) throw new Error('SINGLE_STATUS_REQUIRED');
        const record = read(statuses[0], 'STATUS_REQUEST');
        const p = record.value.payload;
        same(p.requester, { id: user.id, type: 'User' }, 'REQUESTER_MISMATCH');
        authorizeOwner(p.owner);
        currentBinding(p.pluginId, p.owner, p.pluginBindingSha256);
        const publisher = currentPublisher(p.owner);
        const version = state.published(p.pluginId).filter(row => row.value.version === p.version);
        if (version.length !== 1 || version[0].value.package.sha256 !== p.packageSha256) throw new Error('PUBLISHED_VERSION_MISMATCH');
        state.currentStatus(p.pluginId, p.version, p.packageSha256, record.value);
        if (record.value.proofs.activeKey) proof(record, 'STATUS_REQUEST', 'activeKey', activeKey(publisher.value));
        result = { operation: p.action, owner: p.owner, pluginId: p.pluginId, version: p.version, requestId: record.value.requestId,
            requestPath: record.path, requestSha256: record.sha256, bindingSha256: p.pluginBindingSha256,
            publisherSha256: publisher.sha256, recoveryRequired: !record.value.proofs.activeKey };
    } else {
        const roots = new Set(transfers.map(file => file.split('/').slice(0, 3).join('/')));
        if (roots.size !== 1) throw new Error('SINGLE_TRANSFER_REQUIRED');
        const directory = [...roots][0];
        const proposalPath = `${directory}/proposal.json`;
        const proposal = changes.has(proposalPath) ? read(proposalPath, 'TRANSFER') : state.read(proposalPath, 'TRANSFER');
        if (!proposal) throw new Error('TRANSFER_PROPOSAL_MISSING');
        const p = proposal.value.payload;
        currentBinding(p.pluginId, p.from, p.pluginBindingSha256);
        const target = p.targetPublisherRecordSha256 === null ? null : currentPublisher(p.to);
        if (target?.sha256 !== p.targetPublisherRecordSha256 && p.targetPublisherRecordSha256 !== null
            || p.targetPublisherRecordSha256 === null && state.tree.has(publisherPath(p.to))) throw new Error('TARGET_PUBLISHER_CHANGED');
        const key = target ? activeKey(target.value) : p.targetKey;
        if (key.keyId !== p.targetKey.keyId) throw new Error('TARGET_KEY_CHANGED');
        proof(proposal, 'TRANSFER', 'targetKey', key);
        if (!authorize(p.from, user) && !authorize(p.to, user)) throw new Error('TRANSFER_PARTY_REQUIRED');
        for (const role of ['FROM', 'TO']) {
            const file = `${directory}/approvals/${role.toLowerCase()}/${user.id}.json`;
            if (!changes.has(file)) continue;
            const approval = read(file, 'APPROVAL').value;
            same(approval, { schemaVersion: 1, requestId: proposal.value.requestId, role }, 'TRANSFER_APPROVAL_MISMATCH');
            authorizeOwner(role === 'FROM' ? p.from : p.to);
        }
        for (const reference of p.recoveryEvidence ?? []) {
            const bytes = changes.get(reference.path) ?? state.raw(reference.path);
            if (reference.path !== `ownership-transfer-evidence/${p.pluginId}/${reference.sha256}.bin` || !bytes || bytes.length !== reference.size || hash(bytes) !== reference.sha256) {
                throw new Error('RECOVERY_EVIDENCE_MISMATCH');
            }
            allowed.add(reference.path);
        }
        result = { operation: 'OWNERSHIP_TRANSFER', requestId: proposal.value.requestId, from: p.from, to: p.to,
            pluginId: p.pluginId, requestPath: proposal.path, requestSha256: proposal.sha256,
            bindingSha256: p.pluginBindingSha256, publisherSha256: target?.sha256 ?? null, recoveryRequired: p.mode === 'RECOVERY' };
    }
    if (files.some(file => !allowed.has(file))) throw new Error('UNEXPECTED_SUBMISSION_FILE');
    return { ...result, validation: 'STATIC_VALIDATED' };
}
