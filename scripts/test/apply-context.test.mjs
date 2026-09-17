import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { introducedBy, publicationEnvironment, publicationExecution } from '../apply-context.mjs';
import { inputsFrom, waitingProjection } from '../community-publication.mjs';

test('发布与通知分别绑定原生发布工作流，不能借审核通知入口执行', () => {
    const current = 'a'.repeat(40), workflow = '.github/workflows/community-publication.yml';
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, archived: false, private: false };
    const actor = { login: policy.repository.split('/')[0] };
    const env = { GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: policy.repositoryId,
        GITHUB_REF: 'refs/heads/master', GITHUB_REF_PROTECTED: 'true', GITHUB_WORKFLOW_SHA: current,
        GITHUB_WORKFLOW_REF: `${policy.repository}/${workflow}@refs/heads/master`, GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_ACTOR: actor.login, GITHUB_TRIGGERING_ACTOR: actor.login };
    const run = { id: 11, run_attempt: 1, repository: repo, head_repository: repo, workflow_id: 12, path: workflow,
        head_branch: 'master', head_sha: current, event: 'push', actor, triggering_actor: actor };
    const call = endpoint => {
        if (endpoint === prefix) return repo;
        if (endpoint === prefix + '/branches/master') return { commit: { sha: current } };
        if (endpoint === prefix + '/actions/runs/11/attempts/1') return run;
        if (endpoint === prefix + '/actions/workflows/12') return { id: 12, path: run.path };
        throw new Error('Unexpected request ' + endpoint);
    };
    const readGit = () => current;
    for (const event of ['push', 'workflow_dispatch']) {
        run.event = event;
        for (const mode of ['finalize', 'finalize-notify']) assert.equal(publicationExecution(mode, env, call, readGit).current, current);
    }
    assert.throws(() => publicationExecution('notify', env, call, readGit), /WORKFLOW_EXECUTION_INVALID/);
    run.path = '.github/workflows/community-review-complete.yml';
    assert.throws(() => publicationExecution('finalize-notify', env, call, readGit), /WORKFLOW_SOURCE_INVALID/);
});

test('批准事实绑定真实 release 环境、授权个人、当前运行及唯一主分支', () => {
    const reviewer = { id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' };
    const context = { current: 'a'.repeat(40), run: { id: 17, run_attempt: 2, event: 'workflow_dispatch', triggering_actor: reviewer } };
    const environment = { id: 5, can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true },
        protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer }] }] };
    const branches = [{ id: 9, name: 'master', type: 'branch' }];
    const history = [{ state: 'approved', user: reviewer, environments: [{ id: 5, name: 'release' }] }];
    const call = endpoint => {
        if (endpoint.includes('/collaborators?')) return [[reviewer]];
        if (endpoint === `${prefix}/environments/release`) return environment;
        if (endpoint.includes('/deployment-branch-policies?')) return [{ branch_policies: branches, total_count: branches.length }];
        if (endpoint === `${prefix}/actions/runs/17/approvals`) return history;
        throw new Error('Unexpected request ' + endpoint);
    };
    assert.equal(publicationEnvironment(context, { recoveryApproved: false }, call).runAttempt, 2);
    environment.can_admins_bypass = true;
    assert.throws(() => publicationEnvironment(context, {}, call), /PUBLICATION_ENVIRONMENT_UNPROTECTED/);
    environment.can_admins_bypass = false; branches[0].type = 'tag';
    assert.throws(() => publicationEnvironment(context, {}, call), /PUBLICATION_ENVIRONMENT_UNPROTECTED/);
    branches[0].type = 'branch'; history[0].state = 'rejected';
    assert.throws(() => publicationEnvironment(context, {}, call), /PUBLICATION_APPROVAL_REQUIRED/);
    history[0].state = 'approved'; history[0].environments[0].id = 6;
    assert.throws(() => publicationEnvironment(context, {}, call), /PUBLICATION_APPROVAL_REQUIRED/);
});

test('真实 Git 合并第一父链定位批准 PR，后续改写和伪造作者来源拒绝', t => {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'target/apply-provenance-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
    const git = (args, input) => execFileSync('git', ['-C', directory, ...args], { input, encoding: 'utf8', env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q', '-b', 'master']);
    const base = git(['commit-tree', git(['mktree'], '')], 'Base\n');
    const file = `ownership-transfers/demo/${'a'.repeat(64)}/approvals/to/101.json`;
    const blob = git(['hash-object', '-w', '--stdin'], '{}\n');
    git(['update-index', '--add', '--cacheinfo', '100644', blob, file]);
    const tree = git(['write-tree']), head = git(['commit-tree', tree, '-p', base], 'Approval\n');
    const merge = git(['commit-tree', tree, '-p', base, '-p', head], 'Merge approval\n');
    const pr = { number: 3, changed_files: 1, draft: false, merged: true, state: 'closed', merge_commit_sha: merge, user: { id: 101, type: 'User' },
        head: { sha: head, repo: { id: 201 } }, base: { sha: base, ref: 'master', repo: { id: policy.repositoryId } } };
    const call = endpoint => {
        if (endpoint.startsWith(`${prefix}/commits/${merge}/pulls?`)) return [[pr]];
        if (endpoint === `${prefix}/pulls/3`) return pr;
        if (endpoint.startsWith(`${prefix}/pulls/3/files?`)) return [[{ filename: file, status: 'added' }]];
        if (endpoint.includes('/check-runs?')) return [{ total_count: 4, check_runs: policy.requiredContexts.map((name, i) => ({ id: 11 + i, name,
            head_sha: head, app: policy.gateApp, external_id: '17:1:3', status: 'completed', conclusion: 'success' })) }];
        throw new Error('Unexpected request ' + endpoint);
    };
    assert.equal(introducedBy(file, merge, call, args => git(args)).pr.user.id, 101);
    const inputs = { prNumber: '3', expectedHeadSha: head, reason: 'Reviewed request and evidence.' };
    assert.equal(inputsFrom({ inputs }).prNumber, 3);
    assert.throws(() => inputsFrom({ inputs: { ...inputs, reason: '' } }), /DECISION_REASON_INVALID/);
    assert.throws(() => inputsFrom({ inputs: { ...inputs, recoveryApproved: 'yes' } }), /PUBLICATION_INPUT_INVALID/);
    assert.deepEqual(waitingProjection({ ...pr, state: 'open', merged: false }, 'MAINTAINER_EDITS_REQUIRED').labels, ['review:pending']);
    const changed = git(['hash-object', '-w', '--stdin'], '{"changed":true}\n');
    git(['update-index', '--cacheinfo', '100644', changed, file]);
    const later = git(['commit-tree', git(['write-tree']), '-p', merge], 'Changed approval\n');
    assert.throws(() => introducedBy(file, later, call, args => git(args)), /APPROVAL_PROVENANCE_INVALID/);
    pr.user.type = 'Bot';
    assert.throws(() => introducedBy(file, merge, call, args => git(args)), /PR_TARGET_INVALID/);
});
