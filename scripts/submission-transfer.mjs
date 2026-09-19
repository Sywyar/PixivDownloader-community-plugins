import { isDeepStrictEqual } from 'node:util';
import { id, policy, prefix, API_BYTES } from './github.mjs';
import { publisherPath } from './submission-check.mjs';
import { github, paged, eligible, repositoryTree, readBlob, unchanged } from './submission-github.mjs';
import { checkPull } from './submission-pr.mjs';
import { rejectionBody, approvalBody } from './transfer-reviews.mjs';
import { retryStep } from './submission-retry.mjs';
import { currentProof } from './submission-operations.mjs';
import { signOperationProof } from './submission-signing.mjs';
import { authorizeEmergencyKeys } from './emergency-authorization.mjs';

export function openTransfers(context) {
    const { sdk, state, snapshot, call = github } = context;
    const requests = [];
    let total = 0;
    for (const pr of paged(`${prefix}/pulls?state=open&base=${policy.defaultBranch}`, call)) {
        if (pr.state !== 'open' || pr.draft || pr.merged || !pr.head.repo || pr.base.ref !== policy.defaultBranch
            || id(pr.base.repo.id) !== policy.repositoryId || pr.user.type !== 'User' || id(pr.user.id) === snapshot.actor.id) continue;
        const files = paged(`${prefix}/pulls/${id(pr.number)}/files`, call);
        // 已准备结果的 PR 已有所有者确认；之后仍可在网页请求修改，Gate 会撤回准入。
        if (files.some(file => file.filename.startsWith('generated/receipts/'))) continue;
        const proposals = files.filter(file => /^ownership-transfers\/[^/]+\/[a-f0-9]{64}\/proposal\.json$/u.test(file.filename));
        if (proposals.length !== 1 || proposals[0].status !== 'added') continue;
        const file = proposals[0].filename, binding = state.read(`plugin-bindings/${file.split('/')[1]}.json`, 'BINDING');
        if (!binding || !eligible(binding.value.owner, snapshot.actor, call)) continue;
        const tree = repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
        const bytes = readBlob(pr.head.repo.full_name, tree.get(file), call);
        if ((total += bytes.length) > API_BYTES) throw new Error('INPUT_SIZE_EXCEEDED');
        let document;
        try { document = sdk.document('TRANSFER', bytes, file); } catch { continue; }
        const request = document.value;
        if (request.payload.mode !== 'REGULAR' || binding.sha256 !== request.payload.pluginBindingSha256
            || !isDeepStrictEqual(binding.value.owner, request.payload.from)
            || state.tree.has(`audits/${request.requestId}.json`)) continue;
        if ((state.read(publisherPath(request.payload.to), 'PUBLISHER')?.sha256 ?? null)
            !== request.payload.targetPublisherRecordSha256) continue;
        requests.push({ ...document, path: file, openPr: { number: pr.number, head: pr.head.sha, url: pr.html_url } });
    }
    return requests;
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
                && (review.state !== 'COMMENTED' || review.body?.trim() === rejectionBody(proposal.sha256)))
            .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1)[0];
        return latest?.state === expectedState && latest.commit_id === selected.head && latest.body === body
            && latest.pull_request_url === `https://api.github.com/${prefix}/pulls/${selected.number}`;
    };
    await ui.task('writing', () => retryStep('transferReview', async () => {
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
        if (!recorded()) throw new Error('TRANSFER_REVIEW_NOT_CONFIRMED');
    }));
    return { outcome: { transferReviewed: true, signed: Boolean(ownerProof), rejected: reject, number: selected.number, url: selected.url } };
}
