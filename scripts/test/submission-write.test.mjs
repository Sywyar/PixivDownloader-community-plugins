import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root } from '../sdk.mjs';
import { policy } from '../github.mjs';
import { git } from '../project.mjs';
import { forkTarget, submitPreview, submissionBranch, pendingPrepared } from '../submission-write.mjs';

test.before(() => fs.mkdirSync(path.join(root, 'target'), { recursive: true }));

test('主线前进后按原始请求找回所有者或 fork 的 PR，冲突和重复请求拒绝', () => {
    for (const owner of [false, true]) for (const folder of ['submissions', 'key-rotations', 'version-status-requests', 'ownership-transfers']) {
        const actor = { id: owner ? policy.repositoryOwnerId : '101', login: owner ? policy.repository.split('/')[0] : 'author', type: 'User' };
        const snapshot = { repositoryId: policy.repositoryId, base: 'b'.repeat(40), actor };
        const name = `${actor.login}/${policy.repository.split('/')[1]}`;
        const repository = { full_name: name, id: owner ? policy.repositoryId : '202', owner: { id: actor.id },
            fork: !owner, parent: { id: policy.repositoryId } };
        const file = `${folder}/${actor.id}/example/request.json`;
        const bytes = Buffer.from('{"signed":"original bytes"}\n');
        const changes = new Map([[file, bytes]]);
        const pull = { id: 17, number: 17, state: 'open', user: actor, html_url: `https://github.com/${policy.repository}/pull/17`,
            base: { repo: { id: policy.repositoryId }, ref: policy.defaultBranch }, head: { repo: repository, sha: 'c'.repeat(40) } };
        let count = 1, content = bytes;
        const call = (endpoint, options = {}) => {
            assert(!options.method || options.method === 'GET');
            const blob = createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
            if (endpoint.includes('/pulls?')) return [Array.from({ length: count }, (_, i) => ({ ...pull, id: 17 + i, number: 17 + i }))];
            if (endpoint.includes('/files?')) return [[{ filename: file, status: 'added' }]];
            if (endpoint === `repos/${name}`) return repository;
            if (endpoint.includes('/git/trees/')) return { tree: [{ path: file, mode: '100644', type: 'blob', sha: blob, size: content.length }] };
            if (endpoint.includes('/git/blobs/')) return { sha: blob, size: content.length, encoding: 'base64', content: content.toString('base64') };
            assert.fail(endpoint);
        };
        assert.deepEqual(pendingPrepared(snapshot, changes, call), { url: pull.html_url, head: pull.head.sha, reused: true, draft: false });
        pull.draft = true; assert.equal(pendingPrepared(snapshot, changes, call).draft, true); pull.draft = false;
        count = 0; assert.equal(pendingPrepared(snapshot, changes, call), null);
        count = 2; assert.throws(() => pendingPrepared(snapshot, changes, call), /EXISTING_PR_CONFLICT/u);
        count = 1; content = Buffer.from('{"different":true}');
        assert.throws(() => pendingPrepared(snapshot, changes, call), /EXISTING_PR_CONFLICT/u);
        content = bytes; pull.user = { id: '909' };
        assert.throws(() => pendingPrepared(snapshot, changes, call), /EXISTING_PR_CONFLICT/u);
    }
});

test('投稿目标按数字身份区分所有者与 fork，拒绝同名替换和错误归属', () => {
    const snapshot = { actor: { id: policy.repositoryOwnerId, login: policy.repository.split('/')[0] } };
    const repository = { full_name: policy.repository, id: policy.repositoryId,
        owner: { id: policy.repositoryOwnerId }, fork: false };
    assert.deepEqual(forkTarget(snapshot, () => repository), { name: policy.repository, create: false, id: policy.repositoryId });
    for (const changed of [{ id: '909' }, { owner: { id: '909' } }, { fork: true }]) {
        assert.throws(() => forkTarget(snapshot, () => ({ ...repository, ...changed })), /FORK_IDENTITY_CONFLICT/u);
    }
    assert.throws(() => forkTarget(snapshot, () => { throw new Error('GITHUB_NOT_FOUND'); }), /GITHUB_NOT_FOUND/u);
    snapshot.actor = { id: '101', login: 'actor' };
    const name = `actor/${policy.repository.split('/')[1]}`;
    const fork = { full_name: name, id: '202', owner: { id: '101' }, fork: true, parent: { id: policy.repositoryId } };
    assert.deepEqual(forkTarget(snapshot, () => fork), { name, create: false, id: '202' });
    assert.deepEqual(forkTarget(snapshot, () => { throw new Error('GITHUB_NOT_FOUND'); }), { name, create: true });
    for (const changed of [{ fork: false }, { owner: { id: '909' } }, { parent: { id: '909' } }]) {
        assert.throws(() => forkTarget(snapshot, () => ({ ...fork, ...changed })), /FORK_IDENTITY_CONFLICT/u);
    }
});

test('完整预览后才写入；身份、绑定和文件变化阻止 fork、push 与 PR', async t => {
    const directory = fs.mkdtempSync(path.join(root, 'target/submission-write-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let base = 'a'.repeat(40);
    let actor = '101';
    const snapshot = { repositoryId: policy.repositoryId, base, actor: { id: actor, type: 'User', login: 'actor' } };
    const writes = [];
    const call = (endpoint, options = {}) => {
        if (options.method === 'POST') { writes.push(endpoint); throw new Error('UNEXPECTED_WRITE'); }
        if (endpoint === 'user') return { id: actor, type: 'User', login: 'actor' };
        if (endpoint === `repos/${policy.repository}`) return { full_name: policy.repository, id: policy.repositoryId,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint.endsWith('/git/ref/heads/' + policy.defaultBranch)) return { object: { sha: base } };
        if (endpoint.includes('/pulls?')) return [[]];
        throw new Error('GITHUB_NOT_FOUND');
    };
    const changes = new Map([['version-status-requests/101/demo/2.3.4/request.json', Buffer.from('{}\n')]]);
    const input = { sdk: { workspace: directory }, snapshot, changes, result: { operation: 'YANK' }, title: 'chore(plugin): YANK demo',
        call, recheck: async () => {}, readGit: () => { throw new Error('UNEXPECTED_GIT'); } };
    assert.deepEqual(await submitPreview({ ...input, confirm: preview => {
        assert.equal(preview.files[0].content, '{}\n'); assert(preview.body); assert.equal(preview.title, input.title); return false;
    } }), { cancelled: true });
    await assert.rejects(submitPreview({ ...input, confirm: () => { actor = '102'; return true; } }), /COMMUNITY_IDENTITY_CHANGED/u);
    actor = '101';
    await assert.rejects(submitPreview({ ...input, confirm: () => { base = 'b'.repeat(40); return true; } }), /COMMUNITY_BASE_CHANGED/u);
    base = snapshot.base;
    await assert.rejects(submitPreview({ ...input, confirm: () => true, recheck: async () => { throw new Error('BINDING_CONFLICT'); } }), /BINDING_CONFLICT/u);
    await assert.rejects(submitPreview({ ...input, confirm: () => { changes.values().next().value[0] = 32; return true; } }), /PREVIEW_CHANGED/u);
    assert.deepEqual(writes, []);
});

test('已关闭请求重投使用新分支，开放请求保留身份，已合并请求不能再投', () => {
    const snapshot = { actor: { id: '101', login: 'author' } };
    const initial = 'community/yank/abcd';
    const old = { id: 10, number: 10, user: { id: 101 }, state: 'closed', merged_at: null };
    const call = endpoint => [[...(decodeURIComponent(endpoint).includes(initial + '-after-10') ? [] : [old])]];
    assert.equal(submissionBranch(snapshot, initial, call), initial + '-after-10');
    old.state = 'open'; assert.equal(submissionBranch(snapshot, initial, call), initial);
    old.state = 'closed'; old.merged_at = '2026-01-01';
    assert.throws(() => submissionBranch(snapshot, initial, call), /EXISTING_PR_CONFLICT/u);
});

for (const owner of [false, true]) for (const lostResponse of [false, true]) test(`真实 Git ${owner ? '所有者同仓库' : '普通 fork'}投稿在${lostResponse ? 'PR 创建期间' : '推送之后'}主线推进仍复用结果`, async t => {
    const directory = fs.mkdtempSync(path.join(root, 'target/submission-write-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const upstream = path.join(directory, 'upstream');
    const fork = owner ? upstream : path.join(directory, 'fork.git');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '--initial-branch', policy.defaultBranch);
    fs.writeFileSync(path.join(upstream, 'README.md'), 'fixture\n');
    git(upstream, 'add', 'README.md');
    const commit = (cwd, ...args) => git(cwd, '-c', 'user.name=Submission Test', '-c', 'user.email=submission@example.invalid', ...args);
    commit(upstream, 'commit', '-m', 'test: initial fixture');
    const base = git(upstream, 'rev-parse', 'HEAD');
    let currentBase = base;
    const advance = () => {
        fs.writeFileSync(path.join(upstream, 'README.md'), 'unrelated mainline update\n');
        git(upstream, 'add', 'README.md'); commit(upstream, 'commit', '-m', 'test: unrelated update');
        currentBase = git(upstream, 'rev-parse', 'HEAD');
    };
    if (!owner) git(directory, 'clone', '--bare', upstream, fork);
    const scopeRequired = !owner && !lostResponse;
    if (scopeRequired) fs.writeFileSync(path.join(fork, 'hooks/pre-receive'), '#!/bin/sh\n'
        + 'test -f workflow-authorized && exit 0\n'
        + 'echo "refusing to allow an OAuth App to create or update workflow without workflow scope" >&2\nexit 1\n', { mode: 0o755 });
    const actor = { id: owner ? policy.repositoryOwnerId : '101', type: 'User', login: owner ? policy.repository.split('/')[0] : 'actor' };
    const repositoryId = owner ? policy.repositoryId : '202';
    const forkName = actor.login + '/' + policy.repository.split('/')[1];
    const snapshot = { repositoryId: policy.repositoryId, base, actor };
    let candidate;
    let body;
    let failPr = true;
    let createdPr;
    const writes = [];
    let commits = 0;
    let pushes = 0, pushAttempts = 0, scopeRecoveries = 0;
    let confirmations = 0, rechecks = 0, preparations = 0, recoveredDownloads = 0;
    const interrupted = () => Object.assign(new Error('DOWNLOAD_CONNECTION_RESET'), { download: true, retryable: true, downloadStage: 'PROXY_CONNECT', attempts: 3 });
    const call = (endpoint, options = {}) => {
        if (options.method === 'POST') {
            writes.push(endpoint);
            assert.equal(endpoint, `repos/${policy.repository}/pulls`);
            body = options.body;
            if (failPr && !lostResponse) throw Object.assign(new Error('SIMULATED_DISCONNECT'), { github: true });
            if (lostResponse) advance();
            createdPr = { id: 1717, number: 17, state: 'open', draft: body.draft, title: body.title, body: body.body,
                html_url: 'https://github.com/' + policy.repository + '/pull/17', user: { id: actor.id },
                base: { sha: currentBase, ref: body.base }, head: { sha: candidate, repo: { id: repositoryId, full_name: forkName } } };
            if (lostResponse) throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true, method: 'POST' });
            return createdPr;
        }
        if (endpoint === 'user') return actor;
        if (endpoint === `repos/${policy.repository}`) return { full_name: policy.repository, id: policy.repositoryId,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint === `repos/${forkName}`) return { full_name: forkName, id: '202', owner: { id: '101' }, fork: true, parent: { id: policy.repositoryId } };
        if (endpoint === `repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`) return { object: { sha: currentBase } };
        if (endpoint === `repos/${policy.repository}/compare/${base}...${currentBase}`) return {
            status: 'ahead', merge_base_commit: { sha: git(upstream, 'merge-base', base, currentBase) },
        };
        if (endpoint.startsWith(`repos/${forkName}/git/ref/heads/`)) {
            if (!candidate) throw new Error('GITHUB_NOT_FOUND');
            return { object: { sha: candidate } };
        }
        if (endpoint.includes('/pulls?')) return [createdPr ? [createdPr] : []];
        if (endpoint.endsWith('/pulls/17')) return createdPr;
        throw new Error('UNEXPECTED_API ' + endpoint);
    };
    const file = `submissions/${actor.id}/demo/2.3.4.json`;
    const changes = new Map([[file, Buffer.from('{"text":"中文"}\n')]]);
    const readGit = (cwd, ...args) => {
        if (args[0] === 'remote') args[3] = pathToFileURL(args[2] === 'upstream' ? upstream : fork).href;
        if (args[0] === 'commit') { commits++; return commit(cwd, ...args); }
        if (args[0] === 'push') pushAttempts++;
        const result = git(cwd, ...args);
        if (args[0] === 'push') {
            assert.match(args[2], /^HEAD:refs\/heads\/community\/first_release\/[0-9a-f]{24}$/u);
            pushes++; candidate = git(cwd, 'rev-parse', 'HEAD');
            if (lostResponse) throw Object.assign(new Error('GIT_TRANSFER_FAILED'), { github: true, method: 'PUSH' });
        }
        return result;
    };
    const input = { sdk: { workspace: directory, invoke: request => ({ path: path.join(request.root, request.path) }) },
        snapshot, changes, result: { operation: 'FIRST_RELEASE' }, title: 'feat(plugin): demo 2.3.4', call, readGit,
        confirm: preview => {
            confirmations++;
            assert.equal(preview.fork.name, forkName);
            assert.deepEqual(preview.actions, ['CREATE_COMMIT', 'PUSH_BRANCH', 'CREATE_READY_PR']);
            return true;
        }, recheck: async () => { if (++rechecks === 1) throw interrupted(); },
        beforeWrite: async () => { if (++preparations === 1) throw interrupted(); },
        retry: error => {
            if (error.message === 'GIT_WORKFLOW_SCOPE_REQUIRED') {
                assert.equal(error.retryable, false); assert.equal(error.attempts, 1);
                assert.equal(pushAttempts, 1); assert.equal(pushes, 0); assert.equal(commits, 1);
                scopeRecoveries++;
                fs.writeFileSync(path.join(fork, 'workflow-authorized'), '');
                return true;
            }
            if (!error.download) return false;
            recoveredDownloads++; return true;
        } };
    if (lostResponse) assert.equal((await submitPreview(input)).head, candidate);
    else {
        await assert.rejects(submitPreview(input), /SIMULATED_DISCONNECT/u);
        advance();
        input.snapshot = { ...snapshot, base: currentBase }; input.commitBase = base;
        const first = candidate; let retried = 0;
        assert.equal((await submitPreview({ ...input, retry: () => { retried++; failPr = false; return true; } })).head, first);
        assert.equal(retried, 1);
    }
    const firstHead = candidate;
    assert.equal(commits, 1); assert.equal(pushes, 1); assert.equal(body.draft, false);
    assert.equal(pushAttempts, scopeRequired ? 2 : 1); assert.equal(scopeRecoveries, scopeRequired ? 1 : 0);
    assert.equal(recoveredDownloads, 2);
    assert.equal(rechecks, lostResponse ? 2 : 3); assert.equal(preparations, lostResponse ? 2 : 3);
    assert.equal(confirmations, lostResponse ? 1 : 2);
    assert.equal(body.base, policy.defaultBranch);
    assert.equal(body.maintainer_can_modify, true);
    assert.match(body.head, new RegExp(`^${actor.login}:community/first_release/`));
    assert.notEqual(currentBase, base);
    assert.equal(git(upstream, 'rev-parse', policy.defaultBranch), currentBase);
    assert.equal(git(fork, 'rev-parse', firstHead + '^'), base);
    assert(writes.every(endpoint => endpoint.endsWith('/pulls')));
    assert.equal(git(fork, 'show', `${firstHead}:${file}`), '{"text":"中文"}');
    candidate = null; createdPr = null;
    input.snapshot = { ...snapshot, base: currentBase }; input.commitBase = base;
    const before = writes.length;
    await assert.rejects(submitPreview({ ...input, readGit: (cwd, ...args) => {
        if (args.includes('add') && args.includes('--')) fs.writeFileSync(path.join(cwd, file), '{"tampered":true}\n');
        return readGit(cwd, ...args);
    } }), /COMMIT_BYTES_CHANGED/u);
    assert.equal(writes.length, before); assert.equal(pushes, 1);
});
