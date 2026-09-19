import { api } from './github.mjs';
import { hash } from './sdk.mjs';
import { publisherPath, activeKey } from './submission-check.mjs';
import { repositoryTree, readBlob, stateReader } from './submission-github.mjs';
import { emergencyState, keyFingerprint } from './emergency-state.mjs';
import { transferReview, transferProof } from './transfer-reviews.mjs';

// 只枚举这次新操作实际使用的签名；无旧钥证明的人工恢复不依赖已经停用的旧钥。
export function operationKeys(operation, request, publisher, transferOwnerProof = false) {
    if (['FIRST_RELEASE', 'UPDATE'].includes(operation)) return [activeKey(publisher(request.owner))];
    const p = request.payload;
    if (operation === 'KEY_ROTATION') return [p.newKey, ...(request.proofs.oldKey ? [activeKey(publisher({
        accountId: p.githubAccount.id, accountType: p.githubAccount.type, publisherId: p.publisherId,
    }))] : [])];
    if (['YANK', 'UNYANK', 'REVOKE'].includes(operation)) return request.proofs.activeKey ? [activeKey(publisher(p.owner))] : [];
    if (operation === 'OWNERSHIP_TRANSFER') return [p.targetPublisherRecordSha256 === null ? p.targetKey : activeKey(publisher(p.to)),
        ...(transferOwnerProof ? [activeKey(publisher(p.from))] : [])];
    if (operation === 'RENEWAL') return [];
    throw new Error('EMERGENCY_OPERATION_UNKNOWN');
}

// 准入与最终写入均使用当前紧急状态；归档中的成功标记不替代本次读取。
export function authorizeEmergencyKeys(sdk, checked, current, pr, call = api, ownerProof, representations = []) {
    if (!checked || checked.operation === 'RENEWAL') return null;
    const state = stateReader(sdk, current, call);
    let tree;
    const raw = file => {
        tree ??= repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
        return readBlob(pr.head.repo.full_name, tree.get(file), call);
    };
    const file = checked.submissionPath ?? checked.requestPath;
    const bytes = raw(file);
    if (hash(bytes) !== (checked.submissionSha256 ?? checked.requestSha256)) throw new Error('APPLY_REQUEST_CHANGED');
    const request = JSON.parse(bytes.toString('utf8'));
    if (checked.submission) request.owner = checked.owner;
    const signedTransfer = checked.operation === 'OWNERSHIP_TRANSFER' && (ownerProof !== undefined
        || transferProof(checked, transferReview(checked, pr, call, representations)) !== undefined);
    const keys = operationKeys(checked.operation, request, owner => {
        const file = publisherPath(owner);
        return state.read(file, 'PUBLISHER')?.value ?? sdk.document('PUBLISHER', raw(file), file).value;
    }, signedTransfer);
    const emergency = emergencyState(sdk, call);
    if (checked.operation === 'KEY_ROTATION' && request.payload.reasonCode === 'KEY_COMPROMISED') {
        const p = request.payload;
        const old = state.read(publisherPath({ accountId: p.githubAccount.id, publisherId: p.publisherId }), 'PUBLISHER').value;
        if (!emergency.readBlock(keyFingerprint(activeKey(old)))) throw new Error('KEY_COMPROMISE_DECLARATION_REQUIRED');
    }
    for (const key of keys) emergency.requireKey(key);
    emergency.unchanged();
    return emergency;
}
