import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { execution, notificationExecution, gatePath } from '../platform.mjs';
import { publicationExecution } from '../apply-context.mjs';
import { statusExecution } from '../status-execution.mjs';
import { notify } from '../community-gate.mjs';

const notifications = [
    ['community-gate', 'pull_request_target', (...args) => notificationExecution(gatePath, ...args)],
    ['community-status', 'workflow_run', (...args) => statusExecution('notify', ...args)],
    ['community-review-complete', 'workflow_dispatch', (...args) => publicationExecution('notify', ...args)],
    ['community-publication', 'push', (...args) => publicationExecution('finalize-notify', ...args)],
];

function fixture(t, workflow, event) {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'target/notification-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (args, input) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', input, windowsHide: true,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
            GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
    git(['init', '-q']);
    for (const file of ['.github/workflows/test.yml', 'scripts/test.mjs', 'tools/test.txt', 'schemas/test.json', 'package.json']) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), '{}\n');
    }
    git(['add', '.']);
    const source = git(['commit-tree', git(['write-tree'])], 'Source\n');
    git(['update-ref', 'HEAD', source]);
    fs.writeFileSync(path.join(directory, 'publisher.json'), '{"changed":true}\n');
    git(['add', 'publisher.json']);
    const current = git(['commit-tree', git(['write-tree']), '-p', source], 'Merged data\n');
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, private: false, archived: false };
    const actor = { login: 'fixture' }, workflowPath = `.github/workflows/${workflow}.yml`;
    const env = { GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: policy.repositoryId,
        GITHUB_REF: `refs/heads/${policy.defaultBranch}`, GITHUB_REF_PROTECTED: 'true', GITHUB_WORKFLOW_SHA: source,
        GITHUB_WORKFLOW_REF: `${policy.repository}/${workflowPath}@refs/heads/${policy.defaultBranch}`,
        GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: actor.login, GITHUB_TRIGGERING_ACTOR: actor.login };
    const run = { id: 11, workflow_id: 12, run_attempt: 1, repository: repo, head_repository: repo, path: workflowPath,
        head_branch: policy.defaultBranch, head_sha: source, event, actor, triggering_actor: actor };
    const pr = { number: 7, state: 'closed', merged: true, user: { type: 'User' },
        base: { repo, ref: policy.defaultBranch }, head: { repo, sha: current } };
    const f = { source, current, env, run, workflowPath, git, writes: [], pr };
    f.call = (endpoint, options = {}) => {
        if (options.method) { f.writes.push({ endpoint, ...options }); return {}; }
        if (endpoint === prefix) return repo;
        if (endpoint === `${prefix}/branches/${policy.defaultBranch}`) return { commit: { sha: f.current } };
        if (endpoint === `${prefix}/actions/runs/11/attempts/1`) return run;
        if (endpoint === `${prefix}/actions/workflows/12`) return { id: 12, path: workflowPath };
        if (endpoint === `${prefix}/pulls/7`) return pr;
        if (/\/issues\/7\/(?:labels|comments)\?per_page=100$/u.test(endpoint)) return [[]];
        assert.fail(endpoint);
    };
    return f;
}

test('通知及串行集成允许未改变保护面的主线推进，其余执行器保持精确主线绑定', t => {
    for (const [workflow, event, check] of notifications) {
        const f = fixture(t, workflow, event);
        assert.equal(check(f.env, f.call, f.git).current, f.current);
        if (workflow === 'community-publication') assert.throws(() => execution(f.workflowPath, f.env, f.call, f.git), /WORKFLOW_EXECUTION_INVALID/);
        else assert.equal(execution(f.workflowPath, f.env, f.call, f.git).current, f.current);
        const projection = { number: 7, head: f.current, state: 'closed', merged: true, labels: ['state:completed'], summary: 'Applied.' };
        notify([projection], f.call);
        assert.equal(f.writes.length, 2);
        f.writes.length = 0;
        notify([{ ...projection, state: 'open', merged: false }], f.call);
        notify([{ ...projection, head: f.source }], f.call);
        assert.equal(f.writes.length, 0, '旧 PR 状态或 head 不能覆盖当前通知');
        if (workflow === 'community-status') for (const mode of ['preflight', 'prepare', 'store', 'merge']) {
            assert.equal(statusExecution(mode, f.env, f.call, f.git).current, f.current);
        }
        if (workflow === 'community-publication') {
            assert.throws(() => publicationExecution('finalize', f.env, f.call, f.git), /WORKFLOW_EXECUTION_INVALID/);
        }
    }
});

test('通知仍拒绝变化的执行代码、无关历史、错误执行器和身份', t => {
    for (const [workflow, event, check] of notifications) {
        const f = fixture(t, workflow, event);
        for (const patch of [{ GITHUB_WORKFLOW_SHA: f.current }, { GITHUB_REF_PROTECTED: 'false' },
            { GITHUB_REF: 'refs/heads/untrusted' }, { GITHUB_ACTOR: 'other' }, { GITHUB_TRIGGERING_ACTOR: 'other' },
            { GITHUB_REPOSITORY_ID: '999' }, { GITHUB_WORKFLOW_REF: 'untrusted/workflow' }]) {
            assert.throws(() => check({ ...f.env, ...patch }, f.call, f.git));
        }
        const original = f.run.path;
        f.run.path = '.github/workflows/untrusted.yml';
        assert.throws(() => check(f.env, f.call, f.git), /WORKFLOW_SOURCE_INVALID/);
        f.run.path = original;
        f.current = f.git(['commit-tree', f.git(['write-tree'])], 'Unrelated history\n');
        assert.throws(() => check(f.env, f.call, f.git));
        const blob = f.git(['hash-object', '-w', '--stdin'], '{"changed":true}\n');
        f.git(['update-index', '--cacheinfo', '100644', blob, 'scripts/test.mjs']);
        f.current = f.git(['commit-tree', f.git(['write-tree']), '-p', f.source], 'Changed executor\n');
        assert.throws(() => check(f.env, f.call, f.git), /WORKFLOW_SOURCE_CHANGED/);
        assert.equal(f.writes.length, 0);
    }
});
