import { id, policy, prefix, API_BYTES } from './github.mjs';
import { publisherPath } from './submission-check.mjs';
import { github, paged, eligible, repositoryTree, readBlob, unchanged } from './submission-github.mjs';
import { checkPull } from './submission-pr.mjs';
import { rejectionBody, approvalBody, transferReviewBody, reviewNotice } from './transfer-reviews.mjs';
import { retryStep } from './submission-retry.mjs';
import { currentProof } from './submission-operations.mjs';
import { signOperationProof } from './submission-signing.mjs';
import { authorizeEmergencyKeys } from './emergency-authorization.mjs';
import { requestCurrentState } from './submission-current-state.mjs';

const transferFilters = ['transferFilterLabel', 'transferFilterMention'];

export function openTransfers(context, filters = transferFilters) {
    const { sdk, state, snapshot, call = github } = context;
    const requests = [];
    let total = 0;
    const query = new URLSearchParams({ state: 'open' });
    if (filters.includes('transferFilterLabel')) query.set('labels', 'type:ownership-transfer');
    if (filters.includes('transferFilterMention')) query.set('mentioned', snapshot.actor.login);
    // 标签和提及仅缩小读取范围；后续仍按数字身份与原始申请核对处理权限。
    for (const issue of paged(`${prefix}/issues?${query}`, call)) {
        if (!issue.pull_request) continue;
        const pr = call(`${prefix}/pulls/${id(issue.number)}`);
        if (pr.state !== 'open' || pr.merged || !pr.head.repo || pr.base.ref !== policy.defaultBranch
            || id(pr.base.repo.id) !== policy.repositoryId || pr.user.type !== 'User' || id(pr.user.id) === snapshot.actor.id) continue;
        const files = paged(`${prefix}/pulls/${id(pr.number)}/files`, call);
        // 已准备结果的 PR 已有所有者确认；之后仍可在网页请求修改，Gate 会撤回准入。
        if (files.some(file => file.filename.startsWith('generated/receipts/'))) continue;
        const proposals = files.filter(file => /^ownership-transfers\/[^/]+\/[a-f0-9]{64}\/proposal\.json$/u.test(file.filename));
        if (proposals.length !== 1 || proposals[0].status !== 'added') continue;
        const file = proposals[0].filename;
        const tree = repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
        const bytes = readBlob(pr.head.repo.full_name, tree.get(file), call);
        if ((total += bytes.length) > API_BYTES) throw new Error('INPUT_SIZE_EXCEEDED');
        let document;
        try { document = sdk.document('TRANSFER', bytes, file); } catch { continue; }
        const request = document.value;
        if (request.payload.mode !== 'REGULAR' || !eligible(request.payload.from, snapshot.actor, call)
            || state.tree.has(`audits/${request.requestId}.json`)) continue;
        const [facts] = requestCurrentState(context, new Map([[file, bytes]]));
        requests.push({ ...document, path: file, ...facts, openPr: { number: pr.number, head: pr.head.sha, url: pr.html_url, draft: Boolean(pr.draft) } });
    }
    return requests;
}

export async function selectTransfer(context) {
    const { ui } = context;
    let filters = [...transferFilters];
    ui.say('transferFilterHelp');
    for (;;) {
        const requests = await ui.task('loadingTransfers', () => openTransfers(context, filters));
        if (!requests.length) ui.say('noTransferFrom');
        const selected = await ui.select('proposal', [...requests, 'changeTransferFilters'], record =>
            typeof record === 'string' ? ui.text(record)
                : `#${record.openPr.number} ${record.value.payload.from.publisherId}/${record.value.payload.pluginId} → ${record.value.payload.to.publisherId} (${record.value.requestId})`
                    + (record.openPr.draft ? ` · ${ui.text('option.REQUEST_DRAFT')}` : '')
                    + (record.issues.length ? ` · ${ui.text('option.REQUEST_STALE')}` : ''));
        if (selected !== 'changeTransferFilters') {
            if (!selected.openPr.draft && !selected.issues.length) return selected;
            ui.say(selected.openPr.draft ? 'requestDraft' : 'requestStale', { url: selected.openPr.url, ...selected.current });
            for (const issue of selected.issues) ui.say('requestStale', issue);
            continue;
        }
        filters = await ui.multiselect('transferFilterScope', transferFilters, filters);
    }
}

// 在原 PR 留下平台认证的明确决定，不创建第二个分支、PR 或持久化待转移状态。
export async function reviewTransfer(context, proposal, { check = checkPull, proof = currentProof } = {}) {
    const { ui, sdk, snapshot, call = github } = context;
    const selected = proposal.openPr;
    const read = async () => {
        unchanged(snapshot, call);
        const pr = call(`${prefix}/pulls/${id(selected.number)}`);
        if (pr.state !== 'open' || pr.merged || pr.draft || pr.head.sha !== selected.head) throw new Error('TRANSFER_REQUEST_CHANGED');
        if (!eligible(proposal.value.payload.from, snapshot.actor, call)) throw new Error('TRANSFER_PARTY_REQUIRED');
        const checked = await check(selected.number, sdk, call);
        if (checked.operation !== 'OWNERSHIP_TRANSFER' || !checked.singlePr || checked.requestSha256 !== proposal.sha256
            || checked.pr.head !== selected.head) throw new Error('TRANSFER_REQUEST_CHANGED');
        return pr;
    };
    await ui.task('validating', read);
    const decision = await ui.select('transferDecision', ['transferApprove', 'transferReject'], value => ui.text(value));
    const reject = decision === 'transferReject';
    const p = proposal.value.payload;
    let ownerProof;
    if (!reject && p.from.accountType === 'User' && p.to.accountType === 'User') {
        context.bindPublisher?.(p.from);
        const publisher = context.state.read(publisherPath(p.from), 'PUBLISHER');
        if (!publisher) throw new Error('PUBLISHER_REQUIRED');
        const key = await proof(context, publisher.value, true);
        if (key) ownerProof = signOperationProof(sdk, context.sign, 'TRANSFER', proposal.value, key);
    }
    if (!reject) ui.say(ownerProof ? 'statusSigned' : 'statusManual');
    if (!await ui.confirm('transferReview', { operation: ui.text(decision), number: selected.number, url: selected.url,
        from: proposal.value.payload.from, to: proposal.value.payload.to, pluginId: proposal.value.payload.pluginId,
        requestId: proposal.value.requestId, head: selected.head })) throw new Error('CANCELLED');
    context.seal?.();
    const body = reject ? rejectionBody(proposal.sha256) : approvalBody(proposal.sha256, ownerProof);
    const expectedState = reject ? 'CHANGES_REQUESTED' : 'APPROVED';
    const recorded = () => {
        const latest = paged(`${prefix}/pulls/${selected.number}/reviews`, call)
            .filter(review => review.user?.type === 'User' && id(review.user.id) === snapshot.actor.id && review.state !== 'PENDING'
                && (review.state !== 'COMMENTED' || transferReviewBody(review.body) === transferReviewBody(rejectionBody(proposal.sha256))))
            .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0];
        return latest?.state === expectedState && latest.commit_id === selected.head
            && transferReviewBody(latest.body) === transferReviewBody(body)
            && latest.pull_request_url === `https://api.github.com/${prefix}/pulls/${selected.number}` ? latest : undefined;
    };
    const review = await ui.task('writing', () => retryStep('transferReview', async () => {
        const pr = await read();
        if (ownerProof) {
            // 发布者发生换钥或紧急封禁时不再提交旧证明。
            const current = context.state.read(publisherPath(p.from), 'PUBLISHER');
            if (!current?.value.signingKeys.some(key => key.state === 'ACTIVE' && key.keyId === ownerProof.keyId)) throw new Error('TARGET_KEY_CHANGED');
            authorizeEmergencyKeys(sdk, { operation: 'OWNERSHIP_TRANSFER', singlePr: true, from: p.from,
                requestPath: proposal.path, requestSha256: proposal.sha256 }, snapshot.base, pr, call, ownerProof);
        }
        if (!recorded()) {
            try { call(`${prefix}/pulls/${selected.number}/reviews`, { method: 'POST', body: {
                commit_id: selected.head, event: reject ? 'REQUEST_CHANGES' : 'APPROVE', body } }); }
            catch (error) { if (!error.github || !recorded()) throw error; }
        }
        const result = recorded();
        if (!result) throw new Error('TRANSFER_REVIEW_NOT_CONFIRMED');
        return result;
    }));
    const notice = reviewNotice(selected.number, review.id);
    const notified = () => paged(`${prefix}/issues/${selected.number}/comments`, call).some(comment =>
        comment.user?.type === 'User' && id(comment.user.id) === snapshot.actor.id && comment.body === notice);
    await ui.task('writing', () => retryStep('transferReview', async () => {
        if (notified()) return;
        const current = call(`${prefix}/pulls/${selected.number}`);
        if (reject && current.state === 'closed' && !current.merged && current.head.sha === selected.head) return;
        await read();
        if (recorded()?.id !== review.id) throw new Error('TRANSFER_REVIEW_NOT_CONFIRMED');
        // 普通 PR 评论从主线唤醒读取器；授权仍只取原生 Review。
        try { call(`${prefix}/issues/${selected.number}/comments`, { method: 'POST', body: { body: notice } }); }
        catch (error) { if (!error.github || !notified()) throw error; }
        if (!notified()) throw new Error('TRANSFER_REVIEW_NOT_CONFIRMED');
    }));
    return { outcome: { transferReviewed: true, signed: Boolean(ownerProof), rejected: reject, number: selected.number, url: selected.url } };
}
