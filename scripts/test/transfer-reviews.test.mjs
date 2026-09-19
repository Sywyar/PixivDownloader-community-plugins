import test from 'node:test';
import assert from 'node:assert/strict';
import { policy, prefix } from '../github.mjs';
import { hash } from '../sdk.mjs';
import { transferReview, requireTransferReview, closeRejectedTransfer, rejectionBody, approvalBody, transferProof } from '../transfer-reviews.mjs';
import { reviewTransfer, openTransfers } from '../submission-transfer.mjs';
import { withRepositoryFiles } from './local-sdk.mjs';
import { notify } from '../community-gate.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const from = { accountId: '101', accountType: 'User', publisherId: 'original' };
const binding = Buffer.from(JSON.stringify({ owner: from }));
const request = { requestId: 'c'.repeat(64), payload: { from, to: { accountId: '202', accountType: 'User', publisherId: 'recipient' },
    pluginId: 'demo', pluginBindingSha256: hash(binding), targetPublisherRecordSha256: null, mode: 'REGULAR' } };
const bytes = Buffer.from(JSON.stringify(request));
const checked = { operation: 'OWNERSHIP_TRANSFER', singlePr: true, from, requestSha256: hash(bytes), requestId: request.requestId,
    requestPath: `ownership-transfers/demo/${request.requestId}/proposal.json`, pluginId: 'demo', bindingSha256: hash(binding), pr: { head } };
const pr = { id: '700', number: 7, state: 'open', draft: false, merged: false, user: { id: '202', type: 'User' },
    head: { sha: head, repo: { id: '303', full_name: 'recipient/fork' } },
    base: { sha: base, ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
const owner = { id: '101', type: 'User', login: 'original' };
const review = (changes = {}) => ({ id: '91', user: owner, state: 'APPROVED', commit_id: head,
    submitted_at: '2026-01-01T00:00:00Z', pull_request_url: `https://api.github.com/${prefix}/pulls/7`, body: '', ...changes });

test('原所有者确认绑定原生账号和申请 head，撤回、异议、伪造与新 head 均不能沿用', () => {
    for (const [reviews, status] of [[[], 'PENDING'], [[review()], 'APPROVED'],
        [[review({ user: { ...owner, id: '202' } })], 'PENDING'], [[review({ user: { ...owner, type: 'Bot' } })], 'PENDING'],
        [[review({ commit_id: base })], 'PENDING'], [[review({ state: 'DISMISSED' })], 'PENDING'],
        [[review({ state: 'CHANGES_REQUESTED' })], 'CHANGES_REQUESTED'],
        [[review(), review({ id: '92', state: 'DISMISSED' })], 'PENDING'],
        [[review(), review({ id: '92', state: 'COMMENTED' })], 'APPROVED'],
        [[review({ state: 'CHANGES_REQUESTED', body: rejectionBody(checked.requestSha256) })], 'REJECTED']]) {
        const call = () => [reviews];
        assert.equal(transferReview(checked, pr, call).status, status);
        if (status !== 'APPROVED') assert.throws(() => requireTransferReview(checked, pr, call), /TRANSFER_OWNER_/);
    }
    assert.throws(() => transferReview(checked, pr, () => [[review({ pull_request_url: 'https://example.org' })]]), /REVIEW_SOURCE_INVALID/);
    const signed = review({ body: approvalBody(checked.requestSha256, { keyId: 'key', value: 'signature' }) });
    assert.equal(transferProof(checked, transferReview(checked, pr, () => [[signed]])), JSON.stringify({ keyId: 'key', value: 'signature' }));
    assert.equal(transferProof(checked, transferReview(checked, pr, () => [[{ ...signed, state: 'DISMISSED' }]])), undefined);
    assert.equal(transferProof({ ...checked, requestSha256: '0'.repeat(64) }, { status: 'APPROVED', review: signed }), undefined);
    for (const extra of [{ singlePr: false }, { recoveryRequired: true }, { ownerConfirmationInRequest: true }]) {
        assert.equal(transferReview({ ...checked, ...extra }, pr, () => assert.fail('无需原生确认'), undefined), undefined);
    }
});

test('组织代表依赖当前成员身份或受保护人工声明，账号名不能替代数值 ID', () => {
    const value = { ...checked, from: { ...from, accountId: '505', accountType: 'Organization' } };
    let active = true;
    const call = endpoint => endpoint.includes('/reviews?') ? [[review()]] : endpoint.startsWith('organizations/')
        ? { id: '505', type: 'Organization', login: 'group' }
        : { state: active ? 'active' : 'pending', user: owner, organization: { id: '505' } };
    assert.equal(transferReview(value, pr, call).status, 'APPROVED');
    active = false;
    assert.equal(transferReview(value, pr, call).status, 'PENDING');
    assert.equal(transferReview(value, pr, call, ['505:101']).status, 'APPROVED');
    assert.equal(transferReview(value, pr, call, ['505:202']).status, 'PENDING');
});

test('拒绝只关闭对应开放 PR，回读撤回、主线绑定变化或已合并均不写入', () => {
    let current = structuredClone(pr), rows = [review({ state: 'CHANGES_REQUESTED', body: rejectionBody(checked.requestSha256) })];
    const writes = [];
    const rawCall = (endpoint, options = {}) => {
        if (options.method) { writes.push({ endpoint, ...options }); return; }
        if (endpoint.endsWith('/pulls/7')) return current;
        if (endpoint.includes('/reviews?')) return [rows];
        throw new Error(endpoint);
    };
    const call = withRepositoryFiles(withRepositoryFiles(rawCall, pr.head.repo.full_name,
        new Map([[head, new Map([[checked.requestPath, bytes]])]])), policy.repository,
        new Map([[base, new Map([['plugin-bindings/demo.json', binding]])]]));
    const projection = { number: 7, head, rejectedTransfer: { checked, requestHead: head } };
    closeRejectedTransfer(projection, call);
    assert.deepEqual(writes, [{ endpoint: `${prefix}/pulls/7`, method: 'PATCH', body: { state: 'closed' } }]);
    writes.length = 0;
    rows = [review()]; closeRejectedTransfer(projection, call);
    rows = [review({ state: 'CHANGES_REQUESTED', body: rejectionBody(checked.requestSha256) })];
    closeRejectedTransfer({ ...projection, rejectedTransfer: { checked: { ...checked, bindingSha256: '0'.repeat(64) }, requestHead: head } }, call);
    current = { ...current, merged: true, state: 'closed' }; closeRejectedTransfer(projection, call);
    assert.equal(writes.length, 0);
});

test('向导确认与拒绝写入原 PR，丢失响应回读成功不重复创建 Review，也不创建分支', async () => {
    for (const rejected of [false, true]) {
        let rows = [], written = 0, sealed = false;
        const notices = [];
        const call = (endpoint, options = {}) => {
            if (endpoint === 'user') return owner;
            if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository,
                owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
            if (endpoint.endsWith('/git/ref/heads/master')) return { object: { sha: base } };
            if (endpoint === `${prefix}/pulls/7`) return pr;
            if (endpoint.endsWith('/reviews?per_page=100')) return [rows];
            if (options.method === 'POST' && endpoint.endsWith('/reviews')) {
                assert.equal(sealed, true); written++;
                rows = [review({ body: options.body.body, state: rejected ? 'CHANGES_REQUESTED' : 'APPROVED' }),
                    review({ id: '92', state: 'COMMENTED', body: 'Additional context' })];
                throw Object.assign(new Error('GITHUB_CONNECTION_RESET'), { github: true, retryable: true, method: 'POST' });
            }
            assert.fail('Unexpected request ' + endpoint);
        };
        const context = { snapshot: { repositoryId: policy.repositoryId, base, actor: owner }, call, state: { read: () => ({ value: {} }) },
            seal() { sealed = true; }, ui: { say() {}, text: key => key, task: async (_key, work) => work(),
                select: async () => rejected ? 'transferReject' : 'transferApprove', confirm: async (key, value) => { notices.push({ key, value }); return true; } } };
        const result = await reviewTransfer(context, { value: request, sha256: hash(bytes), openPr: { number: 7, head, url: 'https://github.com/example/pr/7' } },
            { check: async () => checked, proof: async () => null });
        assert.equal(result.outcome.rejected, rejected); assert.equal(result.outcome.number, 7);
        assert.equal(written, 1); assert.equal(notices[0].key, 'transferReview');
    }
});

test('原所有者入口从开放 PR 读取申请，不要求申请先合入 master', () => {
    const rows = new Map([[checked.requestPath, bytes]]);
    const call = withRepositoryFiles(endpoint => {
        if (endpoint.includes('/pulls?')) return [[pr]];
        if (endpoint.includes('/files?')) return [[{ filename: checked.requestPath, status: 'added' }]];
        assert.fail(endpoint);
    }, pr.head.repo.full_name, new Map([[head, rows]]));
    const result = openTransfers({ call, snapshot: { actor: owner },
        sdk: { document: () => ({ value: request, sha256: hash(bytes) }) },
        state: { tree: new Map(), read: file => file.startsWith('plugin-bindings/') ? { value: { owner: from }, sha256: hash(binding) } : null } });
    assert.equal(result.length, 1); assert.equal(result[0].openPr.number, 7);
});

test('通知作业关闭拒绝申请后直接更新终态，不依赖 job token 再触发工作流', () => {
    const current = structuredClone(pr), comments = [], writes = [];
    const raw = (endpoint, options = {}) => {
        if (options.method) {
            writes.push({ endpoint, ...options });
            if (endpoint === `${prefix}/pulls/7`) { current.state = 'closed'; return current; }
            if (endpoint === `${prefix}/issues/7/comments`) {
                const comment = { id: '901', user: { id: '41898282', type: 'Bot' }, body: options.body.body };
                comments.push(comment); return comment;
            }
            if (endpoint === `${prefix}/issues/comments/901`) comments[0].body = options.body.body;
            return null;
        }
        if (endpoint === `${prefix}/pulls/7`) return structuredClone(current);
        if (endpoint.includes('/reviews?')) return [[review({ state: 'CHANGES_REQUESTED', body: rejectionBody(checked.requestSha256) })]];
        if (endpoint.includes('/comments?')) return [comments];
        if (endpoint.includes('/labels?')) return [[]];
        assert.fail(endpoint);
    };
    const call = withRepositoryFiles(withRepositoryFiles(raw, pr.head.repo.full_name,
        new Map([[head, new Map([[checked.requestPath, bytes]])]])), policy.repository,
        new Map([[base, new Map([['plugin-bindings/demo.json', binding]])]]));
    notify([{ number: 7, head, state: 'open', merged: false, labels: ['ci:blocked'], summary: 'Rejected',
        rejectedTransfer: { checked, requestHead: head } }], call);
    assert.equal(current.state, 'closed'); assert.equal(comments.length, 1);
    assert(writes.some(row => row.body?.labels?.includes('state:closed')));
    assert.equal(writes.filter(row => row.endpoint === `${prefix}/pulls/7`).length, 1);
    assert(!writes.some(row => row.endpoint.includes('/git/refs') || row.endpoint.includes('/actions')));
});
