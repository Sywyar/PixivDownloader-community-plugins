import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestRenewal, checkRenewal, renewalRequest, renewalBranch, renewalFile, renewalWindow } from '../community-renewal.mjs';
import { policy, prefix } from '../github.mjs';
import { hash } from '../sdk.mjs';

test('续签机器人恢复丢失响应，并用当前主线重建已关闭的续签请求', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-renewal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
    const git = (args, input) => execFileSync('git', ['-C', directory, ...args], {
        input, encoding: 'utf8', env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q', '-b', 'master']);
    const now = Date.now(), nextUpdate = new Date(now + renewalWindow).toISOString();
    const encode = value => Buffer.from(JSON.stringify(value) + '\n');
    const revocations = encode({ schemaVersion: 1, repositoryId: 'pixivdownloader-community', sequence: 2,
        generatedTime: new Date(now - 23 * 86400000).toISOString(), nextUpdate,
        entries: [{ action: 'REVOKED', packageSha256: 'a'.repeat(64) }] });
    const original = new Map([['revocations.json', revocations], ['generated/current.json', encode({
        sequence: 3, revocations: { path: 'generated/generations/3/revocations.json', size: revocations.length, sha256: hash(revocations) } })]]);
    for (const [file, bytes] of original) git(['update-index', '--add', '--cacheinfo', '100644', git(['hash-object', '-w', '--stdin'], bytes), file]);
    const current = git(['commit-tree', git(['write-tree'])], 'Protected state\n');
    git(['update-ref', 'refs/heads/master', current]);
    const read = file => original.get(file) ?? null;
    assert.equal(renewalRequest(() => null, now), null);
    assert.equal(renewalRequest(read, now - 1), null);
    assert.equal(renewalRequest(read, now).generation, 3);
    assert.throws(() => renewalRequest(file => file === 'revocations.json' ? Buffer.from('{}') : read(file), now), /RENEWAL_BASE_INVALID/);
    const repo = { id: policy.repositoryId, full_name: policy.repository };
    const user = { id: 41898282, type: 'Bot' };
    const pulls = [], writes = [], dispatches = [];
    let master = current, ref = null, lostRef = true, lostPull = true;
    const raw = sha => execFileSync('git', ['-C', directory, 'cat-file', 'blob', sha], { windowsHide: true });
    const call = (endpoint, options = {}) => {
        const route = endpoint.split('?')[0], body = options.body;
        if (options.method && options.method !== 'GET') {
            if (route.startsWith(prefix + '/actions/workflows/') && route.endsWith('/dispatches')) {
                assert.equal(options.method, 'POST');
                dispatches.push([route, body]);
                return null;
            }
            writes.push(route);
            if (route === prefix + '/git/blobs') return { sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')) };
            if (route === prefix + '/git/trees') {
                git(['read-tree', body.base_tree]);
                for (const row of body.tree) git(['update-index', '--add', '--cacheinfo', row.mode, row.sha, row.path]);
                return { sha: git(['write-tree']) };
            }
            if (route === prefix + '/git/commits') return { sha: git(['commit-tree', body.tree, ...body.parents.flatMap(sha => ['-p', sha])], body.message) };
            if (route === prefix + '/git/refs' || route === prefix + '/git/refs/heads/' + renewalBranch) {
                if (ref) { assert.equal(body.force, false); git(['merge-base', '--is-ancestor', ref, body.sha]); }
                ref = body.sha;
                if (lostRef) { lostRef = false; throw new Error('RESPONSE_LOST'); }
                return {};
            }
            if (route === prefix + '/pulls') {
                assert.equal(body.maintainer_can_modify, true);
                const number = 9 + pulls.length;
                const pr = { number, user, head: { repo, sha: ref, ref: renewalBranch },
                    base: { repo, sha: master, ref: 'master' }, state: 'open', merged: false, changed_files: 1,
                    html_url: 'https://github.com/' + policy.repository + '/pull/' + number };
                pulls.push(pr);
                if (lostPull) { lostPull = false; throw new Error('RESPONSE_LOST'); }
                return structuredClone(pr);
            }
            assert.fail('Unexpected mutation ' + route);
        }
        if (route === prefix + '/pulls') { assert.ok(endpoint.includes('head=Sywyar:' + renewalBranch)); return [structuredClone(pulls)]; }
        if (route === prefix + '/branches/master') return { commit: { sha: master } };
        if (route.includes('/git/matching-refs/')) return ref ? [{ ref: 'refs/heads/' + renewalBranch, object: { sha: ref } }] : [];
        if (route.includes('/git/ref/heads/')) return { object: { sha: ref } };
        if (route.includes('/git/commits/')) return { tree: { sha: git(['rev-parse', route.split('/').at(-1) + '^{tree}']) } };
        if (route.includes('/git/trees/')) return { truncated: false,
            tree: git(['ls-tree', '-r', '-l', route.split('/').at(-1)]).split('\n').map(line => {
                const [, mode, type, sha, size, path] = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(line);
                return { mode, type, sha, size: Number(size), path };
            }) };
        if (route.includes('/git/blobs/')) {
            const sha = route.split('/').at(-1), bytes = raw(sha);
            return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
        }
        assert.fail('Unexpected request ' + endpoint);
    };
    assert.equal(requestRenewal(current, read, call, now - 1).status, 'NOT_DUE');
    assert.deepEqual(dispatches, []);
    assert.equal(requestRenewal(current, read, call, now).status, 'CREATED');
    assert.equal(git(['diff', '--name-only', current, ref]), renewalFile);
    assert.equal(git(['rev-parse', 'master']), current);
    const pr = pulls[0], files = [{ filename: renewalFile, status: 'added', sha: git(['rev-parse', ref + ':' + renewalFile]) }];
    const expectedDispatches = [
        [prefix + '/actions/workflows/submission-check.yml/dispatches', { ref: 'master', inputs: { prNumber: String(pr.number) } }],
        [prefix + '/actions/workflows/community-gate.yml/dispatches', { ref: 'master', inputs: { prNumber: String(pr.number) } }],
        [prefix + '/actions/workflows/community-status.yml/dispatches',
            { ref: 'master', inputs: { prNumber: String(pr.number), expectedHeadSha: pr.head.sha } }],
    ];
    assert.deepEqual(dispatches.splice(0), expectedDispatches);
    assert.equal(checkRenewal(pr, files, current, call).operation, 'RENEWAL');
    assert.throws(() => checkRenewal({ ...pr, user: { id: 1, type: 'Bot' } }, files, current, call), /RENEWAL_REQUEST_INVALID/);
    assert.throws(() => checkRenewal(pr, [...files, { filename: 'revocations.json' }], current, call), /RENEWAL_REQUEST_INVALID/);
    const writesBefore = writes.length;
    assert.equal(requestRenewal(current, read, call, now).status, 'EXISTING');
    assert.deepEqual(dispatches.splice(0), expectedDispatches);
    pr.state = 'closed';
    assert.equal(requestRenewal(current, read, call, now).status, 'CLOSED');
    assert.deepEqual(dispatches, []);
    assert.equal(writes.length, writesBefore);

    git(['read-tree', current]);
    git(['update-index', '--add', '--cacheinfo', '100644',
        git(['hash-object', '-w', '--stdin'], 'New protected code\n'), 'scripts/maintenance.mjs']);
    master = git(['commit-tree', git(['write-tree']), '-p', current], 'Advance protected mainline\n');
    git(['update-ref', 'refs/heads/master', master]);
    assert.equal(requestRenewal(master, read, call, now).status, 'CREATED');
    const replacement = pulls[1];
    assert.equal(git(['diff', '--name-only', master + '...' + replacement.head.sha]), renewalFile);
    assert.equal(pr.state, 'closed');
    assert.equal(checkRenewal(replacement, [{ filename: renewalFile, status: 'added',
        sha: git(['rev-parse', replacement.head.sha + ':' + renewalFile]) }], master, call).operation, 'RENEWAL');
    assert.deepEqual(dispatches.at(-1), [prefix + '/actions/workflows/community-status.yml/dispatches',
        { ref: 'master', inputs: { prNumber: String(replacement.number), expectedHeadSha: replacement.head.sha } }]);
});
