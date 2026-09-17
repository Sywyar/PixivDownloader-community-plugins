import { id, api } from './github.mjs';
import { hash, evidence } from './sdk.mjs';
import { stateReader, repositoryTree, readBlob } from './submission-github.mjs';
import { applySdk } from './apply-sdk.mjs';
import { applyOperation } from './apply-operations.mjs';

export const signedOwnerOperations = Object.freeze(['YANK', 'UNYANK', 'REVOKE', 'KEY_ROTATION']);
export const signedStatusEligible = checked => signedOwnerOperations.includes(checked?.operation)
    && (checked.operation !== 'KEY_ROTATION' || checked.reasonCode === 'ROUTINE_ROTATION')
    && checked.recoveryRequired === false && checked.owner?.accountType === 'User'
    && checked.owner.accountId === checked.pr?.user.id && !checked.organizationRepresentationRequired?.length;

// 只有请求文件来自投稿分支，其余管理状态始终读取当前受保护主线。
export function statusState(sdk, current, checked, pr, call = api) {
    const state = stateReader(sdk, current, call);
    const tree = repositoryTree(pr.head.repo.full_name, checked.pr.head, call);
    const bytes = readBlob(pr.head.repo.full_name, tree.get(checked.requestPath), call);
    if (hash(bytes) !== checked.requestSha256) throw new Error('APPLY_REQUEST_CHANGED');
    return { ...state, tree: new Map([...state.tree, [checked.requestPath, tree.get(checked.requestPath)]]),
        raw: file => file === checked.requestPath ? bytes : state.raw(file),
        read: (file, kind) => file === checked.requestPath
            ? { ...sdk.document(kind, bytes, file), bytes, path: file } : state.read(file, kind) };
}

export function signedStatusAuthority(request, pr, adapter, native) {
    const reference = adapter.archive({ authorization: 'SIGNED_OWNER', requestId: request.requestId, pr, ...native });
    return { authority: { proposalPr: pr, actualAuthor: { id: id(pr.authorAccountId), type: 'User' },
        representations: [], approval: null, authorizedReviewers: [],
        signedStatus: { requestId: request.requestId, headSha: pr.headSha, evidence: adapter.evidence(reference) } },
        recoveryEvidence: [], reference };
}

export function authorizeStatus(input, sdk, context, version, pr, call = api) {
    if (!signedStatusEligible(version?.checked)) return input;
    const state = statusState(sdk, context.current, version.checked, pr, call);
    const adapter = applySdk(sdk);
    const request = state.read(version.checked.requestPath, version.checked.operation === 'KEY_ROTATION' ? 'ROTATION' : 'STATUS_REQUEST').value;
    const native = { sourceCommit: context.current, runId: id(context.run.id), runAttempt: context.run.run_attempt };
    const authorization = signedStatusAuthority(request, input.after.pr, adapter, native);
    const appliedAt = version.completion?.receipt.appliedAt ?? context.run.created_at;
    const nextUpdate = new Date(Date.parse(appliedAt) + 30 * 86400000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    let result;
    try { result = applyOperation({ sdk, adapter, state, checked: version.checked, ...authorization, appliedAt, nextUpdate }); }
    catch (error) {
        if (!String(error.stderr ?? error.message).includes('COMMUNITY_RESTRICTION_REVIEW_REQUIRED')) throw error;
        version.statusManualReason = 'COMMUNITY_RESTRICTION_REVIEW_REQUIRED';
        return input;
    }
    if (result.replayed) throw new Error('STATUS_REQUEST_ALREADY_APPLIED');
    const ref = evidence(sdk.workspace, result.audit);
    return { ...input, statusAudit: ref, evidence: [...input.evidence, ref] };
}
