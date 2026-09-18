import test from 'node:test';
import assert from 'node:assert/strict';
import { statusInputs, statusEnvironment } from '../status-execution.mjs';
import { mergeStatus, STATUS_CHECK_WAIT_MS } from '../status-merge.mjs';
import { policy, prefix } from '../github.mjs';
import { statusPath } from '../archive-proof.mjs';
import crypto from 'node:crypto';
import { statusState, signedStatusEligible } from '../status-authorization.mjs';
import { hash } from '../sdk.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), merged = 'c'.repeat(40);
test('签名授权只选择个人当前作者，请求取自原 head，管理状态始终读取主线', () => {
    const blobs = new Map();
    const entry = (file, value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
        blobs.set(sha, { sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' });
        return { path: file, sha, size: bytes.length, mode: '100644', type: 'blob' };
    };
    const request = { requestId: 'e'.repeat(64) };
    const requestEntry = entry('request.json', request), currentBinding = entry('plugin-bindings/demo.json', { owner: 'current' });
    const staleBinding = entry('plugin-bindings/demo.json', { owner: 'previous' });
    const checked = { operation: 'YANK', recoveryRequired: false, owner: { accountType: 'User', accountId: '101' },
        pr: { user: { id: '101' }, head }, organizationRepresentationRequired: [], requestPath: 'request.json', requestSha256: hash(Buffer.from(JSON.stringify(request))) };
    const sdk = { document: (_kind, bytes) => ({ value: JSON.parse(bytes), sha256: hash(bytes) }) };
    const call = endpoint => {
        if (endpoint === `${prefix}/git/trees/${base}?recursive=1`) return { tree: [currentBinding] };
        if (endpoint === `repos/author/fork/git/trees/${head}?recursive=1`) return { tree: [requestEntry, staleBinding] };
        const blob = /\/git\/blobs\/([a-f0-9]{40})$/u.exec(endpoint);
        if (blob) return blobs.get(blob[1]);
        assert.fail(endpoint);
    };
    const state = statusState(sdk, base, checked, { head: { repo: { full_name: 'author/fork' } } }, call);
    assert.equal(state.read('plugin-bindings/demo.json', 'BINDING').value.owner, 'current');
    assert.deepEqual(state.read('request.json', 'STATUS_REQUEST').value, request);
    assert.ok(signedStatusEligible(checked));
    const rotation = { ...checked, operation: 'KEY_ROTATION', reasonCode: 'ROUTINE_ROTATION' };
    assert.ok(signedStatusEligible(rotation));
    for (const reasonCode of ['KEY_LOST', 'KEY_COMPROMISED', undefined]) assert.equal(signedStatusEligible({ ...rotation, reasonCode }), false);
    for (const patch of [{ operation: 'KEY_ROTATION' }, { recoveryRequired: true }, { organizationRepresentationRequired: ['202'] },
        { owner: { accountType: 'Organization', accountId: '101' } }, { pr: { user: { id: '202' } } }]) assert.equal(signedStatusEligible({ ...checked, ...patch }), false);
    assert.throws(() => statusState(sdk, base, { ...checked, requestSha256: 'f'.repeat(64) }, { head: { repo: { full_name: 'author/fork' } } }, call), /APPLY_REQUEST_CHANGED/);
});

function fixture() {
    const context = { automatic: true, current: base, run: { id: 51, run_attempt: 1, event: 'workflow_run', path: statusPath } };
    const pr = { number: 7, draft: false, state: 'open', merged: false, user: { id: 101, type: 'User' },
        head: { sha: head, repo: { id: policy.repositoryId } }, base: { sha: base, ref: 'master', repo: { id: policy.repositoryId } } };
    const completion = { pr: structuredClone(pr), receipt: { authorization: 'SIGNED_OWNER', operation: 'YANK', reviewContext: { checked: {} } } };
    const writes = [];
    const f = { context, pr, completion, writes, time: 0, failure: null, conclusion: 'success', role: 'User', issuer: policy.repositoryOwnerId };
    f.call = (endpoint, options = {}) => {
        if (endpoint === 'user') { assert.equal(options.token, 'owner-token'); return { id: f.issuer, type: f.role }; }
        if (endpoint === prefix + '/pulls/7' && !options.method) return structuredClone(pr);
        if (endpoint === prefix + '/branches/master') return { commit: { sha: base } };
        if (endpoint.includes('/check-runs?')) return [{ total_count: 4, check_runs: policy.requiredContexts.map((name, index) => ({
            id: index + 1, name, head_sha: head, app: policy.gateApp, external_id: '61:1:7',
            status: 'completed', conclusion: f.conclusion })) }];
        if (endpoint === prefix + '/git/commits/' + merged) return { sha: merged, parents: [{ sha: base }, { sha: head }] };
        if (options.method) {
            writes.push({ endpoint, ...options });
            if (endpoint.endsWith('/merge')) {
                assert.equal(options.token, 'owner-token');
                assert.deepEqual({ sha: options.body.sha, merge_method: options.body.merge_method }, { sha: head, merge_method: 'merge' });
                if (f.failure === 'protected') throw Object.assign(new Error('blocked'), { stderr: 'gh: protected (HTTP 405)' });
                pr.state = 'closed'; pr.merged = true; pr.merge_commit_sha = merged;
                if (f.failure === 'lost') throw new Error('RESPONSE_LOST');
            }
            return null;
        }
        throw new Error('Unexpected ' + endpoint);
    };
    f.refreshed = 0;
    f.options = { call: f.call, token: 'owner-token', check: async () => completion, readState: () => ({}),
        refresh: async () => { f.refreshed++; return {}; },
        admission: () => {}, now: () => f.time, wait: async milliseconds => { f.time += milliseconds; } };
    return f;
}

test('自动合并复用所有者凭据、等待绑定 App 检查并恢复合并响应丢失', async () => {
    for (const operation of ['YANK', 'UNYANK', 'REVOKE', 'KEY_ROTATION']) for (const failure of [null, 'lost', 'protected']) {
        const f = fixture(); f.failure = failure;
        f.completion.receipt.operation = operation;
        f.completion.receipt.reviewContext.checked = { owner: { publisherId: 'example' },
            ...(operation === 'KEY_ROTATION' ? {} : { pluginId: 'demo', version: '2.3.4-rc.2' }) };
        const result = await mergeStatus(f.context, {}, 7, head, f.options);
        assert.equal(result.merged === true, failure !== 'protected');
        assert.equal(f.writes.filter(row => row.endpoint.endsWith('/merge')).length, 1);
        const title = f.writes.find(row => row.endpoint.endsWith('/merge')).body.commit_title;
        assert(title.includes(operation));
        assert(title.includes(operation === 'KEY_ROTATION' ? '发布者 example' : 'example / demo-v2.3.4-rc.2'));
        assert.equal(f.writes.filter(row => row.endpoint.endsWith('community-publication.yml/dispatches')).length, failure === 'protected' ? 0 : 1);
        assert.equal(f.refreshed, 1);
        assert(!f.writes.some(row => row.endpoint.endsWith('community-gate.yml/dispatches')));
    }
});

test('缺少凭据、错误身份、人工拒绝、head 改变和失败检查均不合并', async () => {
    const missing = fixture();
    assert.equal((await mergeStatus(missing.context, {}, 7, head, { ...missing.options, token: '' })).pending, 'STATUS_MERGE_CREDENTIAL_REQUIRED');
    assert.equal(missing.writes.length, 0);
    for (const mode of ['issuer', 'veto', 'head', 'manual']) {
        const f = fixture();
        if (mode === 'issuer') f.issuer = '999';
        if (mode === 'veto') f.options.admission = () => { throw new Error('PUBLICATION_REVIEW_REQUIRED'); };
        if (mode === 'head') f.pr.head.sha = merged;
        if (mode === 'manual') delete f.completion.receipt.authorization;
        await assert.rejects(mergeStatus(f.context, {}, 7, head, f.options));
        assert.equal(f.writes.length, 0);
    }
    const f = fixture(); f.conclusion = 'failure';
    assert.equal((await mergeStatus(f.context, {}, 7, head, f.options)).pending, 'STATUS_CHECKS_PENDING');
    assert.equal(f.time, STATUS_CHECK_WAIT_MS);
    assert.equal(f.refreshed, 1);
    assert.equal(f.writes.length, 0);
});

test('自动运行只接受静态检查唤醒和无人工审批的 master 环境', () => {
    const f = fixture();
    const run = { id: 71, repository: { id: policy.repositoryId }, status: 'completed', conclusion: 'success',
        path: '.github/workflows/submission-check.yml', display_title: 'Submission PR #7' };
    const environment = { can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [] };
    const branches = [{ id: 1, name: 'master', type: 'branch' }];
    const call = (endpoint, options) => {
        if (endpoint === prefix + '/actions/runs/71') return run;
        if (endpoint === prefix + '/environments/community-status') return environment;
        if (endpoint.includes('/deployment-branch-policies?')) return [{ branch_policies: branches, total_count: branches.length }];
        return f.call(endpoint, options);
    };
    assert.equal(statusInputs(f.context, { workflow_run: { id: 71 } }, call).expectedHeadSha, head);
    assert.equal(statusEnvironment(f.context, {}, call).authorization, 'SIGNED_OWNER');
    run.path = '.github/workflows/untrusted.yml';
    assert.throws(() => statusInputs(f.context, { workflow_run: { id: 71 } }, call), /STATUS_TRIGGER_INVALID/);
    environment.can_admins_bypass = true;
    assert.throws(() => statusEnvironment(f.context, {}, call), /STATUS_ENVIRONMENT_UNPROTECTED/);
    environment.can_admins_bypass = false; branches[0].name = '*';
    assert.throws(() => statusEnvironment(f.context, {}, call), /STATUS_ENVIRONMENT_UNPROTECTED/);
    branches[0].name = 'master';
    assert.throws(() => statusEnvironment(f.context, { recoveryApproved: true }, call), /STATUS_EXECUTION_INVALID/);
});
