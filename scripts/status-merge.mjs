import { setTimeout as delay } from 'node:timers/promises';
import { api, id, sha, list, prefix, policy } from './github.mjs';
import { pull } from './platform.mjs';
import { checkResult } from './apply-result.mjs';
import { restoreReview, currentAdmission } from './apply-context.mjs';
import { stateReader } from './submission-github.mjs';
import { signedOwnerOperations } from './status-authorization.mjs';
import { publish } from './community-gate.mjs';

export const STATUS_CHECK_WAIT_MS = 5_000;
export async function mergeStatus(context, sdk, number, head, { call = api, readGit, check = checkResult,
    admission = currentAdmission, readState = stateReader, token = process.env.COMMUNITY_REVIEW_BRANCH_TOKEN,
    now = Date.now, wait = delay, refresh = publish } = {}) {
    if (!context.automatic) throw new Error('STATUS_EXECUTION_INVALID');
    const bound = () => {
        const pr = pull(number, call);
        if (pr.head.sha !== head || pr.draft || pr.state !== 'open' || pr.merged
            || pr.base.sha !== context.current || sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) {
            throw new Error('PUBLICATION_HEAD_CHANGED');
        }
        return pr;
    };
    const initial = bound();
    if (!token) return { pending: 'STATUS_MERGE_CREDENTIAL_REQUIRED', pr: initial };
    const issuer = call('user', { token });
    if (issuer.type !== 'User' || id(issuer.id) !== policy.repositoryOwnerId) throw new Error('STATUS_MERGE_IDENTITY_INVALID');
    const completion = await check(number, sdk, context.current, { call, readGit });
    if (completion.receipt.authorization !== 'SIGNED_OWNER' || !signedOwnerOperations.includes(completion.receipt.operation)
        || completion.pr.head.sha !== head) throw new Error('STATUS_MANUAL_REVIEW_REQUIRED');
    const reevaluate = () => admission(number, sdk, context,
        { ...restoreReview(sdk, readState(sdk, context.current, call), completion.receipt), completion }, call, readGit);
    reevaluate();
    // 已持有最终写入队列；直接复用 Gate 签发，避免等待同队列另一 workflow 而互相阻塞。
    const refreshed = await refresh(number, context, sdk, call, call, readGit);
    if (refreshed.error) throw new Error(refreshed.error);
    const deadline = now() + STATUS_CHECK_WAIT_MS;
    for (;;) {
        const pr = bound();
        const checks = list(`${prefix}/commits/${sha(head)}/check-runs?filter=latest`, 'check_runs', call);
        const selected = policy.requiredContexts.map(name => checks.filter(row => row.name === name
            && row.head_sha === head && id(row.app.id) === id(policy.gateApp.id) && row.app.slug === policy.gateApp.slug
            && row.external_id?.endsWith(':' + number)));
        if (selected.every(rows => rows.length === 1 && rows[0].status === 'completed' && rows[0].conclusion === 'success')) {
            reevaluate();
            bound();
            let failure;
            try { call(`${prefix}/pulls/${number}/merge`, { method: 'PUT', token, body: { sha: head, merge_method: 'merge',
                commit_title: `chore(community): 合并已签名的 ${completion.receipt.operation} 请求` } }); }
            catch (error) { failure = error; }
            const actual = pull(number, call);
            if (actual.head.sha !== head) throw new Error('PUBLICATION_HEAD_CHANGED');
            if (!actual.merged || actual.state !== 'closed') {
                if (failure && !/\(HTTP (?:405|409)\)/u.test(String(failure.stderr))) throw failure;
                return { pending: 'STATUS_MERGE_BLOCKED', pr: actual };
            }
            const commit = call(`${prefix}/git/commits/${sha(actual.merge_commit_sha)}`);
            if (commit.parents?.length !== 2 || commit.parents[0].sha !== context.current || commit.parents[1].sha !== head) {
                throw new Error('REVIEW_MERGE_CHANGED');
            }
            call(`${prefix}/actions/workflows/community-publication.yml/dispatches`, { method: 'POST', body: { ref: policy.defaultBranch } });
            return { merged: true, head, merge: actual.merge_commit_sha };
        }
        if (now() >= deadline) return { pending: 'STATUS_CHECKS_PENDING', pr };
        await wait(Math.min(1000, deadline - now()));
    }
}
