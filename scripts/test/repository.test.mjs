import test from 'node:test';
import assert from 'node:assert/strict';
import { policy, prefix, list, api, API_BYTES, API_TIMEOUT } from '../github.mjs';
import { labels, labelChanges, syncLabels } from '../sync-labels.mjs';
import { desiredSettings, checkSettings, configure, readSettings } from '../configure-repository.mjs';

function github() {
    const wanted = desiredSettings();
    const state = { repository: { id: Number(policy.repositoryId), full_name: policy.repository,
        owner: { id: Number(policy.repositoryOwnerId), type: 'User' }, default_branch: policy.defaultBranch,
        private: false, archived: false, permissions: { admin: true } },
        user: { id: Number(policy.repositoryOwnerId), type: 'User' },
        token: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true },
        collaborators: [{ id: Number(policy.repositoryOwnerId), role_name: 'admin' }],
        rulesets: [], environments: {}, branches: {}, labels: [{ id: 40, name: 'user-label', color: 'ffffff', description: 'keep' }] };
    const writes = [];
    const call = (endpoint, options = {}) => {
        const path = endpoint.split('?')[0];
        const body = structuredClone(options.body);
        let result;
        if (options.method && options.method !== 'GET') {
            writes.push({ endpoint, ...options });
            if (path === prefix) Object.assign(state.repository, body);
            else if (path.endsWith('/actions/permissions/workflow')) state.token = body;
            else if (path.includes('/rulesets')) {
                for (const rule of body.rules) {
                    if (rule.type === 'update' && rule.parameters?.update_allows_fetch_and_merge === false) delete rule.parameters;
                }
                const existing = state.rulesets.find(rule => path.endsWith(`/${rule.id}`));
                if (existing) Object.assign(existing, body);
                else state.rulesets.push({ id: state.rulesets.length + 1, ...body });
            } else if (path.endsWith('/deployment-branch-policies')) state.branches[path.split('/').at(-2)] = [{ id: 1, ...body }];
            else if (path.includes('/environments/')) {
                const name = path.split('/').at(-1);
                state.environments[name] = { name, can_admins_bypass: body.can_admins_bypass,
                    deployment_branch_policy: body.deployment_branch_policy,
                    protection_rules: body.reviewers.length ? [{ type: 'required_reviewers', prevent_self_review: body.prevent_self_review,
                        reviewers: body.reviewers.map(reviewer => ({ type: reviewer.type, reviewer: { id: reviewer.id } })) }] : [] };
            } else if (path.endsWith('/labels')) state.labels.push({ id: state.labels.length + 100, ...body });
            else if (path.includes('/labels/')) Object.assign(state.labels.find(label => label.name === decodeURIComponent(path.split('/').at(-1))), body);
            else assert.fail(`unexpected write ${path}`);
            return null;
        }
        if (path === 'user') result = state.user;
        else if (path === prefix) result = state.repository;
        else if (path.endsWith(`/branches/${policy.defaultBranch}`)) result = { name: policy.defaultBranch };
        else if (path.endsWith('/actions/permissions/workflow')) result = state.token;
        else if (path.endsWith('/collaborators')) result = state.collaborators;
        else if (path.endsWith('/rulesets')) result = state.rulesets;
        else if (path.includes('/rulesets/')) result = state.rulesets.find(rule => path.endsWith(`/${rule.id}`));
        else if (path.endsWith('/environments')) result = { total_count: Object.keys(state.environments).length, environments: Object.values(state.environments) };
        else if (path.endsWith('/deployment-branch-policies')) {
            const name = path.split('/').at(-2);
            if (!state.environments[name].deployment_branch_policy?.custom_branch_policies) throw new Error('HTTP 404');
            const branches = state.branches[name] ?? [];
            result = { total_count: branches.length, branch_policies: branches };
        } else if (path.includes('/environments/')) result = state.environments[path.split('/').at(-1)];
        else if (path.endsWith('/labels')) result = state.labels;
        else assert.fail(`unexpected read ${path}`);
        return structuredClone(options.pages ? [result] : result);
    };
    return { state, writes, call, wanted };
}

test('配置可重复应用，所有者不能借 PR bypass 跳过四个 App 检查', () => {
    const server = github();
    server.state.environments['community-gate'] = { name: 'community-gate', deployment_branch_policy: null, protection_rules: [] };
    configure(server.call);
    assert.deepEqual(checkSettings(readSettings(server.call)), []);
    const rules = server.state.rulesets;
    const update = rules.find(rule => rule.rules.some(item => item.type === 'update'));
    assert.equal(update.bypass_actors[0].bypass_mode, 'pull_request');
    const gate = rules.find(rule => rule.rules.some(item => item.type === 'required_status_checks'));
    assert.deepEqual(gate.bypass_actors, []);
    assert.equal(gate.rules.find(rule => rule.type === 'pull_request').parameters.required_approving_review_count, 0);
    assert.ok(gate.rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks
        .every(check => check.integration_id === policy.gateApp.id));
    const writes = server.writes.length;
    configure(server.call);
    assert.equal(server.writes.length, writes);
    for (const mutate of [
        snapshot => { snapshot.rulesets.find(rule => rule.name === gate.name).bypass_actors.push(update.bypass_actors[0]); },
        snapshot => { snapshot.rulesets.find(rule => rule.name === update.name).rules[0].parameters.update_allows_fetch_and_merge = true; },
        snapshot => { snapshot.rulesets.find(rule => rule.name === gate.name).rules.find(rule => rule.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = 15368; },
        snapshot => { snapshot.environments.release.can_admins_bypass = true; },
        snapshot => { snapshot.environments.release.protection_rules[0].prevent_self_review = true; },
        snapshot => { snapshot.branches.release.push({ name: '*', type: 'tag' }); },
        snapshot => { snapshot.token.default_workflow_permissions = 'write'; },
        snapshot => { snapshot.token.can_approve_pull_request_reviews = false; },
    ]) {
        const snapshot = readSettings(server.call);
        mutate(snapshot);
        assert.ok(checkSettings(snapshot).length);
    }
});

test('错误仓库、账号、私有状态或额外写入者均在写入前拒绝', () => {
    for (const mutate of [
        state => { state.repository.id++; }, state => { state.user.id++; },
        state => { state.repository.private = true; },
        state => { state.collaborators.push({ id: 777, role_name: 'write' }); },
    ]) {
        const server = github();
        mutate(server.state);
        assert.throws(() => configure(server.call));
        assert.equal(server.writes.length, 0);
    }
    assert.throws(() => api('repos/another/repository', { method: 'DELETE' }), /TARGET_MISMATCH/);
});

test('标签预览只读，应用幂等且保留用户标签', () => {
    const server = github();
    const changes = syncLabels({ call: server.call });
    assert.equal(changes.length, labels.length);
    assert.equal(server.writes.length, 0);
    syncLabels({ call: server.call, apply: true });
    assert.equal(server.state.labels.find(label => label.name === 'user-label').description, 'keep');
    assert.equal(syncLabels({ call: server.call, apply: true }).length, 0);
    server.state.labels.find(label => label.name === labels[0].name).color = 'ffffff';
    assert.equal(labelChanges(server.state.labels).length, 1);
    assert.throws(() => labelChanges([], [...labels, labels[0]]), /CATALOG_INVALID/);
});

test('分页遗漏、重复和来源不完整均失败关闭', () => {
    assert.throws(() => list(`${prefix}/environments`, 'environments', () => [{ total_count: 2, environments: [{ id: 1 }] }]), /INCOMPLETE/);
    assert.throws(() => list(`${prefix}/labels`, null, () => [[{ id: 1 }], [{ id: 1 }]]), /DUPLICATED/);
    assert.deepEqual(list(`${prefix}/labels`, null, () => [[{ id: 1 }], [{ id: 2 }]]), [{ id: 1 }, { id: 2 }]);
});

test('原始 job 日志按字节读取控制字符，普通 API 保留终端保护和失败传播', () => {
    const logs = Buffer.from('2026-01-01T00:00:00Z \u001b[36mrunner\u001b[0m\n');
    const endpoint = `${prefix}/actions/jobs/123/logs`;
    const execute = (_command, args, options) => {
        assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
        assert.equal(options.maxBuffer, API_BYTES);
        assert.equal(options.timeout, API_TIMEOUT);
        if (args.includes('--allow-escape-sequences')) {
            assert.equal(options.encoding, 'buffer');
            return logs;
        }
        return options.encoding === 'buffer' ? Buffer.from('archive') : '{}';
    };
    assert.deepEqual(api(endpoint, { raw: true }, execute), logs);
    assert.deepEqual(api(endpoint, {}, execute), {});
    assert.deepEqual(api(`${prefix}/actions/artifacts/456/zip`, { raw: true }, execute), Buffer.from('archive'));
    const failure = new Error('HTTP failure');
    assert.throws(() => api(endpoint, { raw: true }, () => { throw failure; }), error => error === failure);
});
