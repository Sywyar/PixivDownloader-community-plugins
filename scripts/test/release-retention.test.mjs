import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupOperationArchives, ARCHIVE_RETENTION_MS } from '../release-retention.mjs';
import { reference } from '../receipt-storage.mjs';
import { policy, prefix } from '../github.mjs';

function fixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-retention-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const current = 'b'.repeat(40), requestId = 'a'.repeat(64), time = '2026-01-01T00:00:00Z';
    const receipt = { schemaVersion: 2, repositoryId: policy.repositoryId, baseSha: current, requestId, runId: '11', runAttempt: 1, prNumber: 7, files: [] };
    const manifest = Buffer.from(JSON.stringify(receipt) + '\n'), bundle = Buffer.from('{}');
    const assets = [manifest, bundle].map((bytes, i) => ({ id: i + 1, name: i ? 'publication-attestation.json' : 'publication.json',
        state: 'uploaded', size: bytes.length, digest: 'sha256:' + reference(bytes).sha256 }));
    const release = { id: 501, tag_name: `operation/${requestId}/11-1`, draft: true, published_at: null, updated_at: time };
    const pr = { number: 7, state: 'closed', merged: false, closed_at: time, head: { sha: 'c'.repeat(40) },
        base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    const run = { id: 11, run_attempt: 1, repository: { id: policy.repositoryId }, status: 'completed', updated_at: time };
    const changes = [], options = { now: Date.parse(time) + ARCHIVE_RETENTION_MS, readGit: () => '',
        verify: () => ({ sourceRepositoryDigest: current }), download: (endpoint, file) => fs.writeFileSync(file, endpoint.endsWith('/1') ? manifest : bundle) };
    let exists = true, queries = 0, hook = () => {};
    options.call = (endpoint, request = {}) => {
        hook(endpoint, request);
        if (request.method === 'DELETE') { changes.push(endpoint); exists = false; return null; }
        if (endpoint.includes('/git/trees/')) return { tree: [] };
        if (endpoint.startsWith(prefix + '/pulls?')) { queries++; return [[]]; }
        if (endpoint === prefix + '/pulls/7') return structuredClone(pr);
        if (endpoint === prefix + '/actions/runs/11') return structuredClone(run);
        if (endpoint === prefix + '/branches/master') return { commit: { sha: current } };
        if (endpoint.startsWith(prefix + '/releases/501/assets')) return [structuredClone(assets)];
        if (endpoint === prefix + '/releases/501') {
            if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
            return structuredClone(release);
        }
        assert.fail(endpoint);
    };
    return { release, pr, run, changes, options, execute: () => cleanupOperationArchives(current, [structuredClone(release)], { workspace }, options),
        hook: value => { hook = value; }, queries: () => queries };
}

test('仅清理关闭且无引用满九十天的技术归档，边界前保留', async t => {
    const f = fixture(t);
    f.options.now--;
    assert.equal((await f.execute()).retained[0].reason, 'RETENTION_PERIOD');
    assert.equal(f.changes.length, 0);
    f.options.now++;
    assert.deepEqual((await f.execute()).deleted, ['501']);
    assert.equal(f.changes.length, 1);
});

test('审核尚在使用、引用无法完整读取或删除前重新开放均拒绝清理', async t => {
    for (const mode of ['open', 'merged', 'running', 'incomplete', 'reopen', 'new-base', 'wrong-source']) {
        const f = fixture(t);
        if (mode === 'open') f.pr.state = 'open';
        if (mode === 'merged') f.pr.merged = true;
        if (mode === 'running') f.run.status = 'in_progress';
        if (mode === 'wrong-source') f.run.repository.id = '999';
        if (mode === 'incomplete') f.hook(endpoint => { if (endpoint.includes('/pulls?')) throw new Error('INCOMPLETE_RESPONSE'); });
        if (mode === 'reopen') f.hook(endpoint => { if (endpoint === prefix + '/pulls/7' && f.queries() > 1) f.pr.state = 'open'; });
        if (mode === 'new-base') f.hook(endpoint => { if (endpoint.includes('/branches/')) throw new Error('BASE_CHANGED'); });
        if (['incomplete', 'reopen', 'new-base', 'wrong-source'].includes(mode)) await assert.rejects(f.execute());
        else assert.equal((await f.execute()).retained[0].reason, 'REQUEST_OR_RUN_IN_USE');
        assert.equal(f.changes.length, 0, mode);
    }
});
