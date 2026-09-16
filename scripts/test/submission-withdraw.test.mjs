import test from 'node:test';
import assert from 'node:assert/strict';
import { withdrawRequest } from '../submission-withdraw.mjs';
import { eligible } from '../submission-github.mjs';
import { policy } from '../github.mjs';

test('取消只关闭本人请求，确认后重新核对，响应丢失按远端终态恢复', async () => {
    for (const mode of ['success', 'lost-response', 'cancel', 'head-changed', 'merged']) {
        const actor = { id: '201', type: 'User', login: 'author' };
        let pr = { number: 3, id: 33, title: 'Example', html_url: 'https://github.com/example/pull/3', user: actor,
            head: { sha: 'a'.repeat(40), repo: { id: 22 } }, base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } }, state: 'open', merged: false };
        let writes = 0;
        const call = (endpoint, options = {}) => {
            if (endpoint === 'user') return actor;
            if (endpoint.includes('?state=open')) return [[structuredClone(pr), { ...pr, id: 44, number: 4, user: { id: '999' } }]];
            if (endpoint.includes('/files?')) { assert(endpoint.includes('/3/')); return [[{ filename: 'version-status-requests/201/example/1.0.0/a.json' }]]; }
            if (options.method === 'PATCH') {
                assert.deepEqual(options.body, { state: 'closed' }); writes++; pr.state = 'closed';
                if (mode === 'lost-response') throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true });
            }
            return structuredClone(pr);
        };
        const context = { snapshot: { actor }, call, ui: { select: async (_key, values) => values[0], confirm: async () => {
            if (mode === 'head-changed') pr.head.sha = 'b'.repeat(40);
            if (mode === 'merged') { pr.merged = true; pr.state = 'closed'; }
            return mode !== 'cancel';
        } } };
        if (mode === 'head-changed' || mode === 'merged') await assert.rejects(withdrawRequest(context), /WITHDRAWAL_/u);
        else assert.equal((await withdrawRequest(context))[mode === 'cancel' ? 'cancelled' : 'withdrawn'], true);
        assert.equal(writes, ['success', 'lost-response'].includes(mode) ? 1 : 0);
    }
});

test('无本人请求返回菜单，未加入组织按无资格处理但不吞掉访问或网络故障', async () => {
    await assert.rejects(withdrawRequest({ snapshot: { actor: { id: '201' } }, call: () => [[]],
        ui: { say: (_key, value) => assert.equal(value.code, 'NO_WITHDRAWABLE_REQUESTS') } }), /WIZARD_MENU/u);
    const owner = { accountType: 'Organization', accountId: '301' };
    for (const code of ['GITHUB_NOT_FOUND', 'GITHUB_ACCESS_DENIED', 'GITHUB_REQUEST_FAILED']) {
        const work = () => eligible(owner, { id: '201' }, endpoint => {
            if (endpoint === 'organizations/301') return { id: 301, type: 'Organization', login: 'team' };
            throw Object.assign(new Error(code), { status: code === 'GITHUB_NOT_FOUND' ? 404 : 403 });
        });
        if (code === 'GITHUB_NOT_FOUND') assert.equal(work(), false);
        else assert.throws(work, new RegExp(code));
    }
});
