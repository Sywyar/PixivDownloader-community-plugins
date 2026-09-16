import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { introducedBy, publicationEnvironment } from '../apply-context.mjs';
import { inputsFrom, failedPublication } from '../community-publication.mjs';

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
    const failureCall = endpoint => endpoint.includes('/collaborators?') ? [[{ id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' }]] : call(endpoint);
    const context = { current: merge, run: { id: 17, event: 'workflow_dispatch', triggering_actor: { id: policy.repositoryOwnerId } } };
    const failed = failedPublication(context, inputsFrom({ inputs: { prNumber: '3', expectedHeadSha: head } }), failureCall, args => git(args));
    assert.deepEqual(failed[0].labels, ['state:apply-failed']); assert.equal(failed[0].head, head);
    assert.throws(() => failedPublication(context, { prNumber: 3, expectedHeadSha: 'e'.repeat(40) }, failureCall, args => git(args)), /PUBLICATION_HEAD_CHANGED/);
    assert.deepEqual(inputsFrom({ inputs: { action: 'refresh' } }), { action: 'refresh', recoveryApproved: false, organizationRepresentations: '' });
    assert.throws(() => inputsFrom({ inputs: { action: 'refresh', prNumber: '3' } }), /PUBLICATION_INPUT_INVALID/);
    assert.throws(() => inputsFrom({ inputs: { action: 'unknown' } }), /PUBLICATION_ACTION_INVALID/);
    const changed = git(['hash-object', '-w', '--stdin'], '{"changed":true}\n');
    git(['update-index', '--cacheinfo', '100644', changed, file]);
    const later = git(['commit-tree', git(['write-tree']), '-p', merge], 'Changed approval\n');
    assert.throws(() => introducedBy(file, later, call, args => git(args)), /APPROVAL_PROVENANCE_INVALID/);
    pr.user.type = 'Bot';
    assert.throws(() => introducedBy(file, merge, call, args => git(args)), /PR_TARGET_INVALID/);
});
