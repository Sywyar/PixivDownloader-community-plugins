import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupCandidates } from '../candidate-cleanup.mjs';
import { candidateIdentity, candidateSlot, buildPath } from '../candidate.mjs';
import { cleanupPath, trustedRun } from '../platform.mjs';
import { prefix, policy } from '../github.mjs';
import { hash } from '../sdk.mjs';

function fixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-cleanup-test-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const head = 'a'.repeat(40), current = 'b'.repeat(40);
    const repository = { id: policy.repositoryId, full_name: policy.repository, default_branch: policy.defaultBranch,
        owner: { id: policy.repositoryOwnerId, type: 'User' }, private: false, permissions: { push: true } };
    const pr = { number: 7, state: 'closed', merged: false, user: { type: 'User' },
        head: { sha: head, repo: null }, base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    const candidate = { schemaVersion: 1, state: 'PENDING_REVIEW', repositoryId: policy.repositoryId,
        repositoryOwnerId: policy.repositoryOwnerId, workflowPath: buildPath, workflowSha: current,
        runId: '31', runAttempt: 1, sourceRepositoryId: '201', pr: { number: 7, head, base: current, headId: '301' },
        inputs: {}, inputSha256: hash(Buffer.from('{}')), owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' } };
    const bytes = Buffer.from(JSON.stringify(candidate));
    const reservation = { slot: candidateSlot(candidate), prNumber: 7, headSha: head, runId: '31', runAttempt: 1, manifestSha256: hash(bytes) };
    const marker = value => `<!-- community-candidate:${JSON.stringify(value)} -->`;
    const release = { id: 1, tag_name: reservation.slot, draft: true, published_at: null, body: marker(reservation),
        assets: [{ id: 11, name: 'candidate.json', state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) }] };
    const releases = [release], writes = [], reads = [];
    const missing = () => Object.assign(new Error('Not Found'), { status: 404 });
    let intercept = () => {};
    const call = (endpoint, options = {}) => {
        if (options.method === 'DELETE') {
            writes.push(endpoint);
            const index = releases.findIndex(row => endpoint === `${prefix}/releases/${row.id}`);
            if (index === -1) throw missing();
            releases.splice(index, 1);
            intercept(endpoint, options);
            return null;
        }
        reads.push(endpoint);
        intercept(endpoint, options);
        if (endpoint === prefix) return structuredClone(repository);
        if (endpoint === `${prefix}/pulls/7`) return structuredClone(pr);
        if (endpoint === `${prefix}/releases?per_page=100`) return [structuredClone(releases)];
        const match = new RegExp(`^${prefix}/releases/([1-9][0-9]*)(/assets\\?per_page=100)?$`).exec(endpoint);
        if (match) {
            const row = releases.find(row => String(row.id) === match[1]);
            if (!row) throw missing();
            return structuredClone(match[2] ? [row.assets] : row);
        }
        assert.fail(endpoint);
    };
    const run = () => cleanupCandidates(7, head, workspace, { call, download: (endpoint, file, maximum, expected) => {
        assert.equal(endpoint, `${prefix}/releases/assets/11`);
        assert(bytes.length <= maximum); assert.equal(hash(bytes), expected.sha256); assert.equal(bytes.length, expected.size);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
    } });
    return { pr, repository, head, current, release, releases, writes, reads, candidate, reservation, marker, run,
        intercept: fn => { intercept = fn; } };
}

test('取消申请清理所属草稿，可重复运行且不要求投稿者仓库仍存在', async t => {
    const f = fixture(t);
    f.releases.push({ ...structuredClone(f.release), id: 2, draft: false, published_at: '2026-01-01' },
        { ...structuredClone(f.release), id: 3, tag_name: 'operation/' + 'f'.repeat(64) + '/31-1' },
        { ...structuredClone(f.release), id: 4, tag_name: 'source-candidate' });
    assert.deepEqual((await f.run()).deleted, ['1']);
    assert.deepEqual(f.releases.map(row => row.id), [2, 3, 4]);
    assert.deepEqual((await f.run()).deleted, []);
    assert.equal(f.writes.length, 1);
});

test('旧格式草稿与未完成上传的草稿均可清理', async t => {
    for (const mode of ['legacy', 'interrupted', 'previous-head']) {
        const f = fixture(t);
        if (mode === 'legacy') { f.release.tag_name = candidateIdentity(f.candidate); f.release.body = 'Pending review.'; }
        if (mode === 'interrupted') f.release.assets = [];
        if (mode === 'previous-head') f.release.body = f.marker({ ...f.reservation, headSha: 'c'.repeat(40) });
        assert.deepEqual((await f.run()).deleted, ['1'], mode);
    }
});

test('社区所有者同仓投稿与普通 fork 投稿使用相同清理规则', async t => {
    for (const repositoryId of [policy.repositoryId, '301']) {
        const f = fixture(t);
        f.pr.head.repo = { id: repositoryId };
        assert.deepEqual((await f.run()).deleted, ['1']);
    }
});

test('无草稿读取权限或归属证据无效时拒绝删除', async t => {
    for (const mode of ['permissions', 'slot', 'legacy']) {
        const f = fixture(t);
        if (mode === 'permissions') f.repository.permissions.push = false;
        if (mode === 'slot') f.release.body = f.marker({ ...f.reservation, slot: 'candidate/' + '0'.repeat(64) });
        if (mode === 'legacy') { f.release.tag_name = candidateIdentity(f.candidate).replace(f.head, 'e'.repeat(40)); f.release.body = ''; }
        await assert.rejects(f.run(), /CANDIDATE_(?:ARCHIVE_READ_FORBIDDEN|RELEASE_CHANGED|TAG_CHANGED)/);
        assert.equal(f.writes.length, 0);
    }
});

test('合并、重新打开、关闭事件过时或槽位已被新申请复用时不删除', async t => {
    for (const mode of ['merged', 'reopened', 'changed-head', 'reused', 'published', 'wrong-base']) {
        const f = fixture(t);
        if (mode === 'merged') f.pr.merged = true;
        if (mode === 'reopened') f.pr.state = 'open';
        if (mode === 'changed-head') f.pr.head.sha = 'd'.repeat(40);
        if (mode === 'reused') f.release.body = f.marker({ ...f.reservation, prNumber: 8 });
        if (mode === 'published') f.release.published_at = '2026-01-01';
        if (mode === 'wrong-base') f.pr.base.repo.id = '99';
        if (mode === 'wrong-base') await assert.rejects(f.run(), /PR_TARGET_INVALID/);
        else assert.deepEqual((await f.run()).deleted, [], mode);
        assert.equal(f.writes.length, 0, mode);
    }
});

test('删除前状态和资产变化均保留，原生权限失败不假装清理成功', async t => {
    for (const mode of ['reopen', 'reused', 'published', 'assets', 'denied']) {
        const f = fixture(t);
        let assetReads = 0;
        f.intercept(endpoint => {
            if (endpoint.endsWith('/assets?per_page=100') && ++assetReads === 1) {
                if (mode === 'reopen') f.pr.state = 'open';
                if (mode === 'reused') f.release.body = f.marker({ ...f.reservation, prNumber: 8 });
                if (mode === 'published') f.release.draft = false;
            }
            if (endpoint.endsWith('/assets?per_page=100') && assetReads === 2 && mode === 'assets') f.release.assets[0].id++;
            if (endpoint.endsWith('/releases/1') && mode === 'denied') throw Object.assign(new Error('Forbidden'), { status: 403 });
        });
        if (mode === 'denied') await assert.rejects(f.run(), /Forbidden/);
        else assert.deepEqual((await f.run()).deleted, [], mode);
        assert.equal(f.writes.length, 0, mode);
    }
});

test('删除响应丢失时回读确认，不再发送删除请求', async t => {
    const f = fixture(t);
    f.intercept((endpoint, options) => { if (options.method === 'DELETE') throw new Error('transport reset'); });
    assert.deepEqual((await f.run()).deleted, ['1']);
    assert.equal(f.writes.length, 1);
});

test('清理执行器验证主线来源，不能把 PR head 当作可信代码', () => {
    const current = 'b'.repeat(40), calls = [];
    const run = { id: 31, run_attempt: 1, workflow_id: 51, path: cleanupPath, event: 'pull_request_target',
        head_sha: 'a'.repeat(40), head_branch: 'community/first_release/example',
        repository: { id: policy.repositoryId }, head_repository: { id: policy.repositoryId } };
    const call = endpoint => endpoint.includes('/workflows/') ? { id: 51, path: cleanupPath } : run;
    const readGit = args => { calls.push(args); return 'tree'; };
    assert.equal(trustedRun('31', 1, cleanupPath, current, call, readGit, current).sourceSha, current);
    assert(calls.every(args => !args.some(arg => arg.startsWith(run.head_sha))));
    run.event = 'pull_request';
    assert.throws(() => trustedRun('31', 1, cleanupPath, current, call, readGit, current), /WORKFLOW_SOURCE_INVALID/);
});
