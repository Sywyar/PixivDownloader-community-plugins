import { isDeepStrictEqual } from 'node:util';
import { prefix, policy, id } from './github.mjs';
import { github, eligible, paged } from './submission-github.mjs';
import { activeKey, publisherPath, bindingPath } from './submission-check.mjs';
import { emergencyState, keyFingerprint } from './emergency-state.mjs';
import { formalTag, packageName } from './apply-generation.mjs';
import { canChangeVersion, versionState } from './submission-version-state.mjs';
import { emergencyEligible } from './submission-emergency.mjs';

export function ownershipState(context, pluginId) {
    const currentOwner = context.state.read(bindingPath(pluginId), 'BINDING')?.value.owner ?? null;
    return { pluginId, currentOwner, canManage: Boolean(currentOwner && eligible(currentOwner, context.snapshot.actor, context.call ?? github)) };
}

// 这里只报告 Release 元数据；下载、验签与正式准入仍由发布链执行。
export function publicationState(record, call = github) {
    const tag = formalTag(record), url = `https://github.com/${policy.repository}/releases/tag/${encodeURIComponent(tag)}`;
    try {
        const release = call(`${prefix}/releases/tags/${encodeURIComponent(tag)}`);
        if (release.tag_name !== tag) return { publicationState: 'PUBLICATION_UNCONFIRMED', code: 'PUBLICATION_RELEASE_CHANGED', url };
        if (release.draft) return { publicationState: 'PUBLICATION_DRAFT', url };
        if (!release.published_at) return { publicationState: 'PUBLICATION_UNCONFIRMED', url };
        const assets = paged(`${prefix}/releases/${id(release.id)}/assets`, call);
        const packages = assets.filter(asset => asset.name === packageName(record));
        if (packages.length !== 1 || packages[0].state !== 'uploaded' || packages[0].size !== record.package.expectedSize
            || packages[0].digest !== `sha256:${record.package.sha256}`) {
            return { publicationState: 'PUBLICATION_UNAVAILABLE', code: 'PUBLICATION_PACKAGE_CHANGED', url };
        }
        return { publicationState: 'PUBLICATION_PUBLIC', url };
    } catch (error) {
        if (!error.github) throw error;
        return { publicationState: 'PUBLICATION_UNCONFIRMED', code: error.message, url };
    }
}

// 读取固定主线事实解释旧请求；不生成签名，也不替代提交前的完整校验。
export function requestCurrentState(context, changes) {
    const { state, sdk, snapshot, call = github } = context;
    const result = [];
    for (const [file, bytes] of changes) {
        const kind = file.startsWith('submissions/') ? 'SUBMISSION' : file.startsWith('key-rotations/') ? 'ROTATION'
            : file.startsWith('version-status-requests/') ? 'STATUS_REQUEST'
                : /^ownership-transfers\/[^/]+\/[^/]+\/proposal\.json$/u.test(file) ? 'TRANSFER'
                    : file.startsWith('requests/') ? 'EMERGENCY_REQUEST' : null;
        if (!kind) continue;
        const request = sdk.document(kind, bytes, file).value, p = request.payload ?? request;
        const issues = new Set(), current = {};
        const issue = code => issues.add(code);
        const publisher = owner => state.read(publisherPath(owner), 'PUBLISHER');
        const checkKey = (key, proof) => {
            if (proof && (!key || proof.keyId !== key.keyId)) issue('TARGET_KEY_CHANGED');
            if (!key) return;
            const emergency = context.emergency ??= emergencyState(sdk, call);
            if (emergency.readBlock(keyFingerprint(key))) issue('KEY_DECLARED_COMPROMISED');
        };
        let owner;
        if (kind === 'SUBMISSION') {
            const accountId = file.split('/')[1];
            const publisherFile = `publishers/${accountId}/${p.publisherId}.json`;
            const registered = state.read(publisherFile, 'PUBLISHER');
            const supplied = changes.has(publisherFile) ? sdk.document('PUBLISHER', changes.get(publisherFile), publisherFile) : null;
            const record = registered ?? supplied;
            if (!record) issue('PUBLISHER_REQUIRED');
            else {
                owner = { accountId, accountType: record.value.githubAccount.type, publisherId: p.publisherId };
                current.currentKeyId = activeKey(record.value).keyId;
                checkKey(activeKey(record.value), p.package.signature);
                if (registered && supplied && registered.sha256 !== supplied.sha256) issue('PUBLISHER_CHANGED');
            }
            const previous = state.published(p.pluginId);
            if (previous.some(row => row.value.version === p.version)) issue('VERSION_ALREADY_PUBLISHED');
            if ((previous[0]?.value.sourceCommit ?? null) !== p.source.previousReviewedCommit) issue('PREVIOUS_SOURCE_CHANGED');
        } else if (kind === 'ROTATION') {
            owner = { accountId: p.githubAccount.id, accountType: p.githubAccount.type, publisherId: p.publisherId };
            const record = publisher(owner);
            if (!record || record.sha256 !== p.publisherRecordSha256) issue('PUBLISHER_CHANGED');
            if (record) {
                const key = activeKey(record.value);
                current.currentKeyId = key.keyId;
                if (key.keyId !== p.oldKeyId) issue('TARGET_KEY_CHANGED');
                if (request.proofs.oldKey) checkKey(key, request.proofs.oldKey);
            }
            checkKey(p.newKey);
        } else if (kind === 'TRANSFER') {
            owner = p.from;
            const target = publisher(p.to);
            if ((target?.sha256 ?? null) !== p.targetPublisherRecordSha256) issue('TARGET_PUBLISHER_CHANGED');
            const key = target ? activeKey(target.value) : p.targetKey;
            current.currentKeyId = key.keyId;
            checkKey(key, request.proofs.targetKey);
            if (key.keyId !== p.targetKey.keyId) issue('TARGET_KEY_CHANGED');
        } else {
            owner = p.owner;
            const record = publisher(owner);
            if (!record) issue('PUBLISHER_REQUIRED');
            else if (kind === 'EMERGENCY_REQUEST') {
                current.currentKeyId = activeKey(record.value).keyId;
                if (record.sha256 !== p.publisherRecordSha256) issue('PUBLISHER_CHANGED');
            } else {
                const key = activeKey(record.value);
                current.currentKeyId = key.keyId;
                if (request.proofs.activeKey) checkKey(key, request.proofs.activeKey);
                const version = state.published(p.pluginId).find(row => row.value.version === p.version);
                if (!version || version.value.package.sha256 !== p.packageSha256) issue('PUBLISHED_VERSION_MISMATCH');
                else {
                    const author = state.currentStatus(p.pluginId, p.version, p.packageSha256);
                    Object.assign(current, versionState(state, version, author));
                    if (!canChangeVersion(p.action, current.currentState, author.state)) issue('INVALID_STATE_TRANSITION');
                    if (p.action === 'UNYANK' && p.yankedDecisionSha256 !== author.decisionSha256) issue('YANK_DECISION_CHANGED');
                }
            }
        }
        if (p.pluginId) {
            const binding = state.read(bindingPath(p.pluginId), 'BINDING');
            Object.assign(current, ownershipState(context, p.pluginId));
            if (kind !== 'SUBMISSION' && binding?.sha256 !== p.pluginBindingSha256) issue('BINDING_CHANGED');
            if (binding && owner && !isDeepStrictEqual(binding.value.owner, owner)) issue('BINDING_CONFLICT');
        }
        if (owner && !(kind === 'EMERGENCY_REQUEST' ? emergencyEligible(owner, snapshot.actor, call)
            : kind === 'TRANSFER' ? eligible(p.to, snapshot.actor, call) || eligible(owner, snapshot.actor, call)
            : eligible(owner, snapshot.actor, call))) issue('OWNER_AUTHORIZATION_REQUIRED');
        result.push({ current, issues: [...issues].map(code => ({ code })) });
    }
    return result;
}
