import { api, id, sha, list, prefix, policy } from './github.mjs';
import { repositoryTree, readBlob } from './submission-github.mjs';
import { hash } from './sdk.mjs';

export const rejectionBody = digest => `I reject this ownership transfer and request that this PR be closed.\n\n<!-- PIXIVDOWNLOADER_TRANSFER_REJECT ${digest} -->`;
export const approvalBody = (digest, proof) => `I approve this ownership transfer.\n\n<!-- PIXIVDOWNLOADER_TRANSFER_APPROVE ${digest}${proof ? '\n' + JSON.stringify(proof) : ''} -->`;

export function transferReviewBody(body) {
    if (typeof body !== 'string') return undefined;
    const text = body.trim();
    const payload = /^[^<>]+\n\n<!-- ([\s\S]+) -->$/u.exec(text)?.[1] ?? text;
    if ((payload.match(/PIXIVDOWNLOADER_TRANSFER_/gu) ?? []).length !== 1) return undefined;
    return /^PIXIVDOWNLOADER_TRANSFER_(?:REJECT [a-f0-9]{64}|APPROVE [a-f0-9]{64}(?:\n[\s\S]+)?)$/u.test(payload) ? payload : undefined;
}

export const reviewNotice = (number, reviewId) => `<!-- community-transfer-review:${id(reviewId)} -->\nOwnership transfer review submitted: [view review](https://github.com/${policy.repository}/pull/${id(number)}#pullrequestreview-${id(reviewId)}).`;

export function transferProof(checked, result) {
    const prefix = `PIXIVDOWNLOADER_TRANSFER_APPROVE ${checked.requestSha256}\n`;
    const body = transferReviewBody(result?.review?.body);
    // 原文交给固定 SDK 严格解析和验签；这里仅识别绑定当前申请的证明。
    return result?.status === 'APPROVED' && body?.startsWith(prefix) ? body.slice(prefix.length) : undefined;
}

// 只读取原生 Review 身份和 commit，不信任 PR 正文、评论中的身份或事件载荷。
export function transferReview(checked, pr, call = api, representations = []) {
    if (checked?.operation !== 'OWNERSHIP_TRANSFER' || !checked.singlePr || checked.recoveryRequired
        || checked.ownerConfirmationInRequest) return undefined;
    const owner = checked.from;
    const members = new Map();
    const represents = user => {
        if (user?.type !== 'User') return false;
        const person = id(user.id);
        if (owner.accountType === 'User') return owner.accountId === person;
        if (representations.includes(`${owner.accountId}:${person}`)) return true;
        if (!members.has(person)) {
            const org = call(`organizations/${id(owner.accountId)}`);
            if (id(org.id) !== owner.accountId || org.type !== 'Organization' || !/^[A-Za-z0-9-]+$/u.test(org.login)
                || !/^[A-Za-z0-9-]+$/u.test(user.login)) throw new Error('ORGANIZATION_IDENTITY_CHANGED');
            try {
                const membership = call(`orgs/${org.login}/memberships/${user.login}`);
                members.set(person, membership.state === 'active' && id(membership.user.id) === person
                    && id(membership.organization.id) === owner.accountId);
            } catch (error) {
                if (!/\b(?:403|404)\b/u.test(String(error.stderr ?? error.message))) throw error;
                members.set(person, false); // 私有组织成员由受保护审核显式核实，不能猜测授权。
            }
        }
        return members.get(person);
    };
    const latest = new Map();
    const rejects = review => ['COMMENTED', 'CHANGES_REQUESTED'].includes(review.state)
        && transferReviewBody(review.body) === `PIXIVDOWNLOADER_TRANSFER_REJECT ${checked.requestSha256}`;
    for (const review of list(`${prefix}/pulls/${id(pr.number)}/reviews`, null, call)) {
        if (review.state === 'PENDING' || !represents(review.user)) continue;
        if (review.pull_request_url !== `https://api.github.com/${prefix}/pulls/${pr.number}`
            || !Number.isFinite(Date.parse(review.submitted_at))) throw new Error('REVIEW_SOURCE_INVALID');
        id(review.id); sha(review.commit_id);
        const rejected = rejects(review);
        if (review.state === 'COMMENTED' && !rejected) continue;
        if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(review.state)) throw new Error('REVIEW_SOURCE_INVALID');
        const previous = latest.get(id(review.user.id));
        if (!previous || Date.parse(review.submitted_at) > Date.parse(previous.submitted_at)
            || Date.parse(review.submitted_at) === Date.parse(previous.submitted_at) && BigInt(review.id) > BigInt(previous.id)) {
            latest.set(id(review.user.id), review);
        }
    }
    const values = [...latest.values()].filter(review => review.commit_id === pr.head.sha);
    const rejected = values.find(rejects);
    if (rejected) return { status: 'REJECTED', review: rejected };
    if (values.some(review => review.state === 'CHANGES_REQUESTED')) return { status: 'CHANGES_REQUESTED' };
    const approved = values.filter(review => review.state === 'APPROVED')
        .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || (BigInt(b.id) > BigInt(a.id) ? 1 : -1))[0];
    return approved ? { status: 'APPROVED', review: approved } : { status: 'PENDING' };
}

export function requireTransferReview(checked, pr, call = api, representations = []) {
    const result = transferReview(checked, pr, call, representations);
    if (result && result.status !== 'APPROVED') throw new Error(result.status === 'REJECTED'
        ? 'TRANSFER_OWNER_REJECTED' : 'TRANSFER_OWNER_CONFIRMATION_REQUIRED');
    return result;
}

export function nativeTransferApproval(checked, pr, result, adapter) {
    const review = result?.review;
    if (!review || result.status !== 'APPROVED') return undefined;
    const person = id(review.user.id);
    const file = `ownership-transfers/${checked.pluginId}/${checked.requestId}/approvals/from/${person}.json`;
    return { reference: adapter.archive({ schemaVersion: 1, requestId: checked.requestId, role: 'FROM' }), path: file,
        role: 'FROM', pr, author: { id: person, type: 'User' }, ownerProof: transferProof(checked, result), review: {
            id: id(review.id), githubRepositoryId: policy.repositoryId, prNumber: pr.number,
            reviewer: { id: person, type: 'User' }, headSha: review.commit_id, state: 'APPROVED', submittedAt: review.submitted_at,
            evidence: adapter.evidence(adapter.archive(review)), dismissal: null } };
}

// 通知作业仅关闭明确拒绝的未合并请求；在写入前重新读取请求、绑定和原生 Review。
export function closeRejectedTransfer(projection, call = api) {
    const pr = call(`${prefix}/pulls/${id(projection.number)}`);
    const { checked, requestHead } = projection.rejectedTransfer;
    if (pr.state !== 'open' || pr.merged || pr.head.sha !== projection.head || pr.base.ref !== policy.defaultBranch
        || id(pr.base.repo.id) !== policy.repositoryId) return;
    const tree = repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
    const bytes = readBlob(pr.head.repo.full_name, tree.get(checked.requestPath), call);
    if (hash(bytes) !== checked.requestSha256) throw new Error('TRANSFER_REQUEST_CHANGED');
    const base = repositoryTree(policy.repository, pr.base.sha, call);
    if (hash(readBlob(policy.repository, base.get(`plugin-bindings/${checked.pluginId}.json`), call)) !== checked.bindingSha256) return;
    const result = transferReview(checked, { ...pr, head: { ...pr.head, sha: sha(requestHead) } }, call);
    if (result?.status !== 'REJECTED') return;
    const latest = call(`${prefix}/pulls/${id(pr.number)}`);
    if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha || latest.state !== 'open' || latest.merged) return;
    const closed = () => {
        const value = call(`${prefix}/pulls/${pr.number}`);
        return value.head.sha === pr.head.sha && value.state === 'closed' && !value.merged;
    };
    try { call(`${prefix}/pulls/${pr.number}`, { method: 'PATCH', body: { state: 'closed' } }); }
    catch (error) { if (!closed()) throw error; }
    return closed();
}
