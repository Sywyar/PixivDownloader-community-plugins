import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from '../sdk.mjs';
import { policy } from '../github.mjs';
import { git } from '../project.mjs';
import { submitPreview } from '../submission-write.mjs';

test('完整预览后才写入；身份、绑定和文件变化阻止 fork、push 与 PR', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'target/submission-write-'));
    const base = 'a'.repeat(40);
    let actor = '101';
    const snapshot = { repositoryId: policy.repositoryId, base, actor: { id: actor, type: 'User', login: 'actor' } };
    const writes = [];
    const call = (endpoint, options = {}) => {
        if (options.method === 'POST') { writes.push(endpoint); throw new Error('UNEXPECTED_WRITE'); }
        if (endpoint === 'user') return { id: actor, type: 'User', login: 'actor' };
        if (endpoint === `repos/${policy.repository}`) return { full_name: policy.repository, id: policy.repositoryId,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint.endsWith('/git/ref/heads/' + policy.defaultBranch)) return { object: { sha: base } };
        throw new Error('GITHUB_NOT_FOUND');
    };
    const changes = new Map([['version-status-requests/101/demo/2.3.4/request.json', Buffer.from('{}\n')]]);
    const input = { sdk: { workspace: directory }, snapshot, changes, result: { operation: 'YANK' }, title: 'chore(plugin): YANK demo',
        call, recheck: async () => {}, readGit: () => { throw new Error('UNEXPECTED_GIT'); } };
    assert.deepEqual(await submitPreview({ ...input, confirm: preview => {
        assert.equal(preview.files[0].content, '{}\n'); assert(preview.body); assert.equal(preview.title, input.title); return false;
    } }), { cancelled: true });
    await assert.rejects(submitPreview({ ...input, confirm: () => { actor = '102'; return true; } }), /IDENTITY_OR_BASE_CHANGED/u);
    actor = '101';
    await assert.rejects(submitPreview({ ...input, confirm: () => true, recheck: async () => { throw new Error('BINDING_CONFLICT'); } }), /BINDING_CONFLICT/u);
    await assert.rejects(submitPreview({ ...input, confirm: () => { changes.values().next().value[0] = 32; return true; } }), /PREVIEW_CHANGED/u);
    assert.deepEqual(writes, []);
});

test('真实 Git 提交核对字节，普通 push 后断线可复用同一 head 创建 Ready PR', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'target/submission-write-'));
    const upstream = path.join(directory, 'upstream');
    const fork = path.join(directory, 'fork.git');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '--initial-branch', policy.defaultBranch);
    fs.writeFileSync(path.join(upstream, 'README.md'), 'fixture\n');
    git(upstream, 'add', 'README.md');
    const commit = (cwd, ...args) => git(cwd, '-c', 'user.name=Submission Test', '-c', 'user.email=submission@example.invalid', ...args);
    commit(upstream, 'commit', '-m', 'test: initial fixture');
    const base = git(upstream, 'rev-parse', 'HEAD');
    git(directory, 'clone', '--bare', upstream, fork);
    const forkName = 'actor/' + policy.repository.split('/')[1];
    const snapshot = { repositoryId: policy.repositoryId, base, actor: { id: '101', type: 'User', login: 'actor' } };
    let candidate;
    let body;
    let failPr = true;
    let createdPr;
    const writes = [];
    let commits = 0;
    let pushes = 0;
    const call = (endpoint, options = {}) => {
        if (options.method === 'POST') {
            writes.push(endpoint);
            assert.equal(endpoint, `repos/${policy.repository}/pulls`);
            body = options.body;
            if (failPr) throw new Error('SIMULATED_DISCONNECT');
            createdPr = { number: 17, state: 'open', draft: body.draft, title: body.title, body: body.body,
                html_url: 'https://github.com/' + policy.repository + '/pull/17', user: { id: '101' },
                base: { sha: base }, head: { sha: candidate, repo: { id: '202' } } };
            return createdPr;
        }
        if (endpoint === 'user') return { id: '101', type: 'User', login: 'actor' };
        if (endpoint === `repos/${policy.repository}`) return { full_name: policy.repository, id: policy.repositoryId,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint === `repos/${forkName}`) return { full_name: forkName, id: '202', owner: { id: '101' }, fork: true, parent: { id: policy.repositoryId } };
        if (endpoint === `repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`) return { object: { sha: base } };
        if (endpoint.startsWith(`repos/${forkName}/git/ref/heads/`)) {
            if (!candidate) throw new Error('GITHUB_NOT_FOUND');
            return { object: { sha: candidate } };
        }
        if (endpoint.includes('/pulls?')) return [[]];
        if (endpoint.endsWith('/pulls/17')) return createdPr;
        throw new Error('UNEXPECTED_API ' + endpoint);
    };
    const changes = new Map([['submissions/101/demo/2.3.4.json', Buffer.from('{"text":"中文"}\n')]]);
    const readGit = (cwd, ...args) => {
        if (args[0] === 'remote') args[3] = pathToFileURL(args[2] === 'upstream' ? upstream : fork).href;
        if (args[0] === 'commit') { commits++; return commit(cwd, ...args); }
        const result = git(cwd, ...args);
        if (args[0] === 'push') { pushes++; candidate = git(cwd, 'rev-parse', 'HEAD'); }
        return result;
    };
    const input = { sdk: { workspace: directory, invoke: request => ({ path: path.join(request.root, request.path) }) },
        snapshot, changes, result: { operation: 'FIRST_RELEASE' }, title: 'feat(plugin): demo 2.3.4', call, readGit,
        confirm: () => true, recheck: async () => {} };
    await assert.rejects(submitPreview(input), /SIMULATED_DISCONNECT/u);
    const firstHead = candidate;
    failPr = false;
    assert.equal((await submitPreview(input)).head, firstHead);
    assert.equal(commits, 1); assert.equal(pushes, 1); assert.equal(body.draft, false);
    assert.equal(body.base, policy.defaultBranch);
    assert(writes.every(endpoint => endpoint.endsWith('/pulls')));
    assert.equal(git(fork, 'show', `${firstHead}:submissions/101/demo/2.3.4.json`), '{"text":"中文"}');
    candidate = null;
    const before = writes.length;
    await assert.rejects(submitPreview({ ...input, readGit: (cwd, ...args) => {
        if (args.includes('add') && args.includes('--')) fs.writeFileSync(path.join(cwd, 'submissions/101/demo/2.3.4.json'), '{"tampered":true}\n');
        return readGit(cwd, ...args);
    } }), /COMMIT_BYTES_CHANGED/u);
    assert.equal(writes.length, before); assert.equal(pushes, 1);
});
