import { isDeepStrictEqual } from 'node:util';
import { id, policy } from './github.mjs';
import { actor, github, paged } from './submission-github.mjs';
import { unavailable } from './submission-navigation.mjs';
import { cleanupRequestBranch } from './submission-cleanup.mjs';

const endpoint = `repos/${policy.repository}/pulls`;
const requestPath = /^(?:submissions|key-rotations|version-status-requests|ownership-transfers|requests)\/.+\.json$/u;
const identity = pr => ({ number: pr.number, author: id(pr.user.id), repository: id(pr.base.repo.id), base: pr.base.ref,
    headRepository: pr.head.repo ? id(pr.head.repo.id) : null, head: pr.head.sha, branch: pr.head.ref });

// 取消审核只关闭本人未合并的请求，不删除候选、源码 Release 或已发布记录。
export async function withdrawRequest(context) {
    const { ui, snapshot, call = github } = context;
    const requests = [];
    for (const pr of paged(`${endpoint}?state=open`, call)) {
        if (![policy.defaultBranch, policy.emergencyBranch].includes(pr.base.ref)) continue;
        if (id(pr.user.id) !== snapshot.actor.id || pr.user.type !== 'User') continue;
        const files = paged(`${endpoint}/${id(pr.number)}/files`, call);
        if (files.some(file => requestPath.test(file.filename))) requests.push(pr);
    }
    if (!requests.length) unavailable(ui, 'NO_WITHDRAWABLE_REQUESTS');
    const selected = await ui.select('withdrawalRequest', requests, pr => `#${pr.number} ${pr.title}`);
    const expected = identity(selected);
    const read = () => {
        if (!isDeepStrictEqual(actor(call), snapshot.actor)) throw new Error('SESSION_ACCOUNT_CHANGED');
        const current = call(`${endpoint}/${selected.number}`);
        if (!isDeepStrictEqual(identity(current), expected) || current.user.type !== 'User'
            || expected.repository !== policy.repositoryId || ![policy.defaultBranch, policy.emergencyBranch].includes(expected.base)) throw new Error('WITHDRAWAL_REQUEST_CHANGED');
        if (current.merged) throw new Error('WITHDRAWAL_ALREADY_MERGED');
        if (!['open', 'closed'].includes(current.state)) throw new Error('WITHDRAWAL_REQUEST_CHANGED');
        return current;
    };
    let current = read();
    if (current.state === 'open') {
        if (!await ui.confirm('withdrawConfirm', { number: selected.number, title: current.title,
            url: current.html_url, head: expected.head })) return { cancelled: true };
        current = read();
        if (current.state === 'open') {
            try { call(`${endpoint}/${selected.number}`, { method: 'PATCH', body: { state: 'closed' } }); }
            catch (error) { if (!error.github || read().state !== 'closed') throw error; }
        }
    }
    current = read();
    if (current.state !== 'closed') throw new Error('WITHDRAWAL_NOT_CONFIRMED');
    const branchCleanup = await cleanupRequestBranch(context, { number: selected.number,
        head: expected.head, branch: expected.branch, repositoryId: expected.headRepository });
    return { withdrawn: true, number: selected.number, url: current.html_url, branchCleanup };
}
