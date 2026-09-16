import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanupRequestBranch, deleteRequestBranch } from '../submission-cleanup.mjs';
import { policy } from '../github.mjs';
import { navigation } from '../submission-navigation.mjs';

function fixture(owner, mode) {
    const actor = { id: owner ? policy.repositoryOwnerId : '201', type: 'User', login: owner ? 'Sywyar' : 'author' };
    const repository = { id: owner ? policy.repositoryId : '202', full_name: owner ? policy.repository : 'author/community-plugins',
        owner: actor, default_branch: 'master', fork: !owner, parent: { id: policy.repositoryId } };
    if (!owner) repository.full_name = 'author/' + policy.repository.split('/')[1];
    const branch = 'community/yank/' + 'a'.repeat(24), head = 'b'.repeat(40);
    const pr = { number: 3, state: 'closed', merged: false, user: actor, head: { ref: branch, sha: head, repo: repository },
        base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    let missing = mode === 'missing', writes = 0, confirmations = 0;
    const notes = [];
    const call = (endpoint) => {
        if (endpoint === 'user') return actor;
        if (endpoint === `repos/${policy.repository}/pulls/3`) return structuredClone(pr);
        if (endpoint === `repos/${repository.full_name}`) return repository;
        if (endpoint.includes('/branches/') && !endpoint.includes('/rules/')) {
            if (missing) throw new Error('GITHUB_NOT_FOUND');
            return { commit: { sha: mode === 'changed' && confirmations ? 'c'.repeat(40) : head }, protected: mode === 'protected' };
        }
        if (endpoint.includes('/rules/branches/')) return mode === 'ruleset' ? [{ type: 'deletion' }] : [];
        if (endpoint.includes('?state=open&head=')) return mode === 'shared' ? [[{ id: 4, head: pr.head }]] : [[]];
        throw new Error('Unexpected endpoint: ' + endpoint);
    };
    const context = { snapshot: { actor }, sdk: { workspace: 'unused' }, call, remove(_workspace, target) {
        assert.equal(target.repositoryId, repository.id); assert.equal(target.head, head); assert.equal(target.branch, branch);
        writes++; missing = true;
        if (mode === 'lost-response') throw Object.assign(new Error('GIT_TRANSFER_FAILED'), { github: true });
    }, ui: { say(key, value) { notes.push({ key, value }); }, async confirm(key) {
        assert.equal(key, 'deleteRequestBranch'); confirmations++; return mode !== 'decline';
    } } };
    return { context, pr, repository, withdrawn: { number: 3, head, branch, repositoryId: repository.id },
        facts: () => ({ writes, confirmations, notes }) };
}

test('个人 fork 与所有者同仓投稿均逐次确认，拒绝保护分支、并发更新和其他开放请求', async () => {
    for (const owner of [false, true]) for (const mode of ['success', 'lost-response', 'decline', 'missing', 'changed', 'protected', 'ruleset', 'shared', 'default', 'foreign']) {
        const f = fixture(owner, mode);
        if (mode === 'default') f.pr.head.ref = f.withdrawn.branch = 'master';
        if (mode === 'foreign') f.repository.owner = { id: '999' };
        const removed = ['success', 'lost-response', 'missing'].includes(mode);
        assert.equal(await cleanupRequestBranch(f.context, f.withdrawn), removed ? 'removed' : 'retained', `${owner}/${mode}`);
        assert.equal(f.facts().writes, ['success', 'lost-response'].includes(mode) ? 1 : 0, `${owner}/${mode}`);
        assert.equal(f.facts().confirmations, ['success', 'lost-response', 'decline', 'changed'].includes(mode) ? 1 : 0);
    }
});

test('恢复表单不会复用历史删除许可，关闭请求后取消清理仍保留取消结果', async () => {
    let history, confirmations = 0;
    const ui = { confirm: async () => { confirmations++; return true; } };
    await navigation(ui, () => null, { onChange: value => { history = value; } }).ui.confirm('deleteRequestBranch', { head: 'a' });
    await navigation(ui, () => null, { history }).ui.confirm('deleteRequestBranch', { head: 'a' });
    assert.equal(confirmations, 2);
    const f = fixture(true, 'success');
    f.context.ui.confirm = async () => { throw new Error('CANCELLED'); };
    assert.equal(await cleanupRequestBranch(f.context, f.withdrawn), 'retained');
    assert.equal(f.facts().writes, 0);
});

test('真实 Git 删除 lease 拒绝确认后的新提交，仅删除精确目标 ref', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-delete-'));
    const remote = path.join(directory, 'remote.git'), source = path.join(directory, 'source');
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    fs.mkdirSync(source); git(directory, 'init', '--bare', remote); git(source, 'init');
    git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    const head = git(source, 'rev-parse', 'HEAD'), branch = 'community/yank/' + 'a'.repeat(24);
    git(source, 'push', remote, `HEAD:refs/heads/${branch}`, 'HEAD:refs/heads/master');
    const run = (cwd, ...args) => git(cwd, ...args.map(arg => arg === 'https://github.com/fixture/repo.git' ? remote : arg));
    git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'new');
    git(source, 'push', remote, `HEAD:refs/heads/${branch}`);
    assert.throws(() => deleteRequestBranch(directory, { repository: 'fixture/repo', branch, head }, run));
    assert.equal(git(directory, '--git-dir', remote, 'rev-parse', `refs/heads/${branch}`), git(source, 'rev-parse', 'HEAD'));
    deleteRequestBranch(directory, { repository: 'fixture/repo', branch, head: git(source, 'rev-parse', 'HEAD') }, run);
    assert.throws(() => git(directory, '--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`));
    assert.equal(git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/master'), head);
});
