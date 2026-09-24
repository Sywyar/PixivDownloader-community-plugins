import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendReviewCommit, checkResult, makeReceipt, receiptPath, receiptExpired, reviewPrerequisite, forkApi, REVIEW_READBACK_ATTEMPTS } from '../apply-result.mjs';
import { encoded } from '../apply-generation.mjs';
import { hash, root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { reference, proofPath } from '../receipt-storage.mjs';

test('fork API 只读并核对数字归属，禁止借用合并令牌写 fork', () => {
    const pr = { head: { repo: { id: 201, full_name: 'author/community' } } };
    const repository = { id: 201, full_name: 'author/community', fork: true, parent: { id: policy.repositoryId }, private: false, archived: false };
    let calls = 0;
    const scoped = forkApi(pr, (endpoint, options) => {
        calls++; assert.equal(options.repositoryName, repository.full_name);
        assert.equal(options.token, undefined); return repository;
    });
    for (const method of ['PATCH', 'POST', 'DELETE']) assert.throws(() => scoped('repos/author/community/git/refs/heads/request', { method }), /FORK_API_WRITE_FORBIDDEN/);
    assert.equal(calls, 1);
    repository.parent.id = '999';
    assert.throws(() => forkApi(pr, () => repository), /FORK_IDENTITY_CONFLICT/);
});
test('完成审核只快进原 PR，真实 Git 父链和字节拒绝夹带与并发改写', async t => {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const workspace = fs.mkdtempSync(path.join(root, 'target/review-commit-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const directory = path.join(workspace, 'repository'); fs.mkdirSync(directory);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
    const git = (args, input, extra = {}) => execFileSync('git', ['-C', directory, ...args],
        { encoding: 'utf8', windowsHide: true, input, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q', '-b', 'master']);
    const add = (file, bytes) => git(['update-index', '--add', '--cacheinfo', '100644', git(['hash-object', '-w', '--stdin'], bytes), file]);
    for (const file of ['.github/fixture', 'scripts/fixture', 'tools/fixture', 'schemas/fixture', 'package.json']) add(file, '{}');
    const baseline = encoded({ sequence: 1 }); add('generated/current.json', baseline);
    const source = git(['commit-tree', git(['write-tree'])], 'Baseline\n');
    git(['update-ref', 'refs/heads/master', source]);
    const requestPath = `version-status-requests/101/demo/2.3.4/${'a'.repeat(64)}.json`;
    add(requestPath, encoded({ requestId: 'a'.repeat(64) }));
    const requested = git(['commit-tree', git(['write-tree']), '-p', source], 'Request\n');
    git(['read-tree', source]);
    add('plugin-bindings/another.json', encoded({ owner: 'another' }));
    const latest = git(['commit-tree', git(['write-tree']), '-p', source], 'Independent request merged\n');
    git(['update-ref', 'refs/heads/master', latest]);
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, archived: false, private: false };
    const pr = { number: 7, user: { id: 101, type: 'User' }, head: { sha: requested, repo, ref: 'community/request' },
        base: { sha: source, ref: 'master', repo }, changed_files: 1, merged: false, state: 'open', draft: false };
    git(['update-ref', 'refs/heads/' + pr.head.ref, requested]);
    const inputFiles = [{ filename: requestPath, status: 'added', sha: git(['rev-parse', requested + ':' + requestPath]) }];
    let made = makeReceipt({ requestId: 'a'.repeat(64), operation: 'YANK', pr: { ...structuredClone(pr), base: { ...pr.base, sha: latest } }, current: latest,
        run: { id: 11, run_attempt: 1, sourceSha: source }, appliedAt: '2026-01-02T00:00:00Z', inputFiles,
        writes: new Map([['generated/current.json', encoded({ sequence: 2 })],
            ['revocations.json', encoded({ nextUpdate: new Date(Date.now() + 86400000).toISOString() })]]),
        state: { raw: file => file === 'generated/current.json' ? baseline : null }, releases: [],
        reviewContext: { checked: { owner: { publisherId: 'example' }, pluginId: 'demo', version: '2.3.4' } } });
    const proof = Buffer.from('{}'), blobs = new Map([['601', made.bytes], ['602', proof]]);
    let pointer = { schemaVersion: 2, manifest: reference(made.bytes), attestation: reference(proof) };
    let proofs = new Map([[proofPath(pointer.manifest.sha256), made.bytes], [proofPath(pointer.attestation.sha256), proof]]);
    assert(JSON.parse(made.bytes).files.every(file => file.bytes === undefined));
    const assets = [...blobs].map(([id, bytes], i) => ({ id, name: i ? 'publication-attestation.json' : 'publication.json',
        state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) }));
    let current = latest, lostResponse = true, extraTreeFile = false, staleReads = 2, waits = 0;
    const mutations = [];
    const call = (endpoint, options = {}) => {
        const route = endpoint.split('?')[0], body = options.body;
        if (options.method && options.method !== 'GET') {
            mutations.push(route);
            if (route === prefix + '/git/blobs') return { sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')) };
            if (route === prefix + '/git/trees') {
                git(['read-tree', body.base_tree]);
                for (const row of body.tree) git(['update-index', '--add', '--cacheinfo', row.mode, row.sha, row.path]);
                if (extraTreeFile) add('scripts/injected.mjs', 'untrusted');
                return { sha: git(['write-tree']) };
            }
            if (route === prefix + '/git/commits') return { sha: git(['commit-tree', body.tree, ...body.parents.flatMap(parent => ['-p', parent])], body.message,
                { GIT_AUTHOR_DATE: body.author.date, GIT_COMMITTER_DATE: body.committer.date }) };
            if (route === prefix + '/git/refs/heads/' + pr.head.ref) {
                assert.equal(body.force, false);
                git(['merge-base', '--is-ancestor', pr.head.sha, body.sha]);
                git(['update-ref', 'refs/heads/' + pr.head.ref, body.sha]);
                pr.head.sha = body.sha; pr.base.sha = current; pr.changed_files = 1 + made.value.files.length + 1 + proofs.size;
                if (lostResponse) { lostResponse = false; throw new Error('RESPONSE_LOST'); }
                return {};
            }
            throw new Error('Unexpected mutation ' + route);
        }
        if (route === prefix) return repo;
        if (route === prefix + '/branches/master') return { commit: { sha: current } };
        if (route === prefix + '/pulls/7') {
            const snapshot = structuredClone(pr);
            if (pr.head.sha !== requested && staleReads-- > 0) snapshot.head.sha = requested;
            return snapshot;
        }
        if (route === prefix + '/git/ref/heads/' + pr.head.ref) return { object: { sha: git(['rev-parse', 'refs/heads/' + pr.head.ref]) } };
        if (route === prefix + '/pulls/7/files') return [pr.head.sha === requested ? inputFiles
            : [...inputFiles, ...made.value.files.map(file => ({ filename: file.path, status: file.before ? 'modified' : 'added' })),
                { filename: receiptPath(made.value.requestId), status: 'added' }, ...[...proofs.keys()].map(filename => ({ filename, status: 'added' }))]];
        if (route.includes('/git/commits/')) {
            const sha = route.split('/').at(-1);
            return { sha, tree: { sha: git(['rev-parse', sha + '^{tree}']) },
                parents: git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1).map(sha => ({ sha })) };
        }
        if (route.includes('/git/trees/')) return { truncated: false,
            tree: git(['ls-tree', '-r', '-l', route.split('/').at(-1)]).split('\n').filter(Boolean).map(line => {
                const [, mode, type, sha, size, path] = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(line);
                return { mode, type, sha, size: Number(size), path };
            }) };
        if (route.includes('/git/blobs/')) {
            const sha = route.split('/').at(-1), bytes = execFileSync('git', ['-C', directory, 'cat-file', 'blob', sha], { windowsHide: true });
            return { sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' };
        }
        if (route === prefix + '/releases/501') return { id: 501, tag_name: `operation/${made.value.requestId}/11-1` };
        if (route === prefix + '/releases/501/assets') return [assets];
        throw new Error('Unexpected request ' + endpoint);
    };
    const options = { call, readGit: args => git(args), verify: () => ({ sourceRepositoryDigest: source }),
        download: (endpoint, file) => fs.writeFileSync(file, blobs.get(endpoint.split('/').at(-1)), { flag: 'wx' }) };
    assert.equal(reviewPrerequisite({ ...pr, head: { ...pr.head, repo: { id: 123 } } }, requested, source), 'MAINTAINER_EDITS_REQUIRED');
    const result = await appendReviewCommit(made.value, pointer, call, { proofs, wait: async ms => { assert.equal(ms, 1000); waits++; } });
    assert.equal(waits, 2);
    assert.equal(mutations.filter(route => route === prefix + '/git/refs/heads/' + pr.head.ref).length, 1);
    assert.equal(result.pr.number, 7); assert.notEqual(result.head, requested);
    assert.match(git(['show', '-s', '--format=%s', result.head]), /YANK 请求审核：example \/ demo-v2\.3\.4$/u);
    assert.equal(git(['rev-parse', 'master']), latest);
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', result.head]).split(' ').slice(1), [requested, latest]);
    assert.equal(git(['show', result.head + ':plugin-bindings/another.json']), '{"owner":"another"}');
    git(['merge-base', '--is-ancestor', latest, result.head]);
    assert.ok(!mutations.some(route => route === prefix + '/pulls' || route === prefix + '/git/refs'));
    assert.equal((await checkResult(7, { workspace }, current, options)).receipt.headSha, requested);
    assert.equal(receiptExpired(made.value), false);
    assert.equal(receiptExpired(made.value, Date.now() + 86400001), true);
    const generated = pr.head.sha;
    pr.head.sha = git(['commit-tree', git(['rev-parse', generated + '^{tree}']), '-p', generated], 'Author edit\n');
    await assert.rejects(checkResult(7, { workspace }, current, options), /REVIEW_PARENT_CHANGED/);
    pr.head.sha = requested; pr.changed_files = 1; extraTreeFile = true;
    await appendReviewCommit(made.value, pointer, call, { proofs });
    await assert.rejects(checkResult(7, { workspace }, current, options), /APPLY_WRITE_FORBIDDEN/);
    pr.head.sha = generated;
    pr.merge_commit_sha = git(['commit-tree', git(['rev-parse', generated + '^{tree}']), '-p', latest, '-p', generated], 'Merge\n');
    pr.state = 'closed'; pr.merged = true; current = pr.merge_commit_sha;
    assert.equal((await checkResult(7, { workspace }, current, { ...options, merged: true })).merge.sha, current);
    pr.merge_commit_sha = git(['commit-tree', git(['rev-parse', generated + '^{tree}']), '-p', generated, '-p', source], 'Wrong merge\n');
    await assert.rejects(checkResult(7, { workspace }, current, { ...options, merged: true }), /REVIEW_MERGE_CHANGED/);

    // 写入后中断，另一请求先合并：验证旧证明，再追加新生成提交；无需作者更新或强推。
    git(['read-tree', latest]);
    add('plugin-bindings/third.json', encoded({ owner: 'third' }));
    current = git(['commit-tree', git(['write-tree']), '-p', latest], 'Another request merged\n');
    git(['update-ref', 'refs/heads/master', current]);
    git(['update-ref', 'refs/heads/' + pr.head.ref, generated]);
    pr.head.sha = generated; pr.state = 'open'; pr.merged = false; extraTreeFile = false;
    await assert.rejects(checkResult(7, { workspace }, current, options), /APPLY_BASE_CHANGED/);
    const prior = (await checkResult(7, { workspace }, current, { ...options, refresh: true })).receipt;
    made = makeReceipt({ ...prior, pr: { ...prior.originalPr, base: { ...prior.originalPr.base, sha: current } },
        current, previousHead: generated, run: { id: 12, run_attempt: 1, sourceSha: source },
        writes: new Map(prior.files.map(file => [file.path, Buffer.from(file.bytes, 'base64')])),
        state: { raw: file => file === 'generated/current.json' ? baseline : null } });
    pointer = { schemaVersion: 2, manifest: reference(made.bytes), attestation: reference(proof) };
    proofs = new Map([[proofPath(pointer.manifest.sha256), made.bytes], [proofPath(pointer.attestation.sha256), proof]]);
    const refreshed = await appendReviewCommit(made.value, pointer, call, { proofs });
    git(['merge-base', '--is-ancestor', generated, refreshed.head]);
    git(['merge-base', '--is-ancestor', current, refreshed.head]);
    assert.equal((await checkResult(7, { workspace }, current, options)).receipt.previousHead, generated);
    assert.equal(git(['show', refreshed.head + ':plugin-bindings/third.json']), '{"owner":"third"}');
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', refreshed.head]).split(' ').slice(1), [requested, current, generated]);
});

test('审核提交回读只等待旧 PR 视图，拒绝分支、主线及请求状态变化', async () => {
    const base = 'a'.repeat(40), head = 'b'.repeat(40), generated = 'c'.repeat(40), other = 'd'.repeat(40);
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, archived: false, private: false };
    for (const scenario of ['stale', 'branch', 'head', 'base', 'pr-base', 'closed', 'merged', 'draft', 'denied']) {
        let written = false, writes = 0, waits = 0;
        const failure = new Error('WRITE_DENIED');
        const receipt = { requestId: '1'.repeat(64), baseSha: base, headSha: head, prNumber: 7, operation: 'FIRST_RELEASE',
            files: [], appliedAt: '2026-01-02T00:00:00Z' };
        const call = (endpoint, options = {}) => {
            if (endpoint === prefix) return repo;
            if (endpoint === prefix + '/branches/master') return { commit: { sha: written && scenario === 'base' ? other : base } };
            if (endpoint === prefix + '/pulls/7') return { number: 7, user: { id: 101, type: 'User' },
                head: { sha: written && scenario === 'head' ? other : head, repo, ref: 'community/request' },
                base: { sha: written && scenario === 'pr-base' ? other : base, repo, ref: 'master' },
                state: written && scenario === 'closed' ? 'closed' : 'open', merged: written && scenario === 'merged', draft: written && scenario === 'draft' };
            if (endpoint === prefix + '/git/blobs' || endpoint === prefix + '/git/trees') return { sha: other };
            if (endpoint === prefix + '/git/commits/' + head) return { tree: { sha: other } };
            if (endpoint === prefix + '/git/commits') return { sha: generated };
            if (endpoint === prefix + '/git/refs/heads/community/request') {
                assert.equal(options.body.force, false); writes++;
                if (scenario === 'denied') throw failure;
                written = true; return { object: { sha: generated } };
            }
            if (endpoint === prefix + '/git/ref/heads/community/request') return { object: { sha: !written ? head : scenario === 'branch' ? other : generated } };
            throw new Error('Unexpected request ' + endpoint);
        };
        await assert.rejects(appendReviewCommit(receipt, {}, call, { wait: async () => { waits++; } }), error => {
            if (scenario === 'denied') return error.message === 'REVIEW_BRANCH_WRITE_FAILED' && error.diagnostic.phase === 'push';
            assert.match(error.message, new RegExp('^' + (scenario === 'stale' ? 'PUBLICATION_HEAD_NOT_VISIBLE' : 'PUBLICATION_HEAD_CHANGED') + ': '));
            const details = JSON.parse(error.message.slice(error.message.indexOf(': ') + 2));
            assert.equal(details.expectedHead, generated); assert.equal(details.expectedBase, base);
            return true;
        });
        assert.equal(writes, 1, scenario);
        assert.equal(waits, scenario === 'stale' ? REVIEW_READBACK_ATTEMPTS - 1 : 0, scenario);
    }
});

test('自动生成的 Git 提交标题标明版本、发布者、转移双方或续签对象', async () => {
    const base = 'a'.repeat(40), head = 'b'.repeat(40), generated = 'c'.repeat(40);
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, archived: false, private: false };
    for (const [operation, checked, subject] of [
        ['FIRST_RELEASE', { owner: { publisherId: 'example' }, submission: { pluginId: 'demo', version: '2.3.4-rc.2' } }, 'example / demo-v2.3.4-rc.2'],
        ['UPDATE', { owner: { publisherId: 'example' }, pluginId: 'demo', version: '2.3.5' }, 'example / demo-v2.3.5'],
        ...['YANK', 'UNYANK', 'REVOKE'].map(operation => [operation, { owner: { publisherId: 'example' }, pluginId: 'demo', version: '2.3.4' }, 'example / demo-v2.3.4']),
        ['KEY_ROTATION', { owner: { publisherId: 'example' } }, '发布者 example'],
        ['OWNERSHIP_TRANSFER', { from: { publisherId: 'old' }, to: { publisherId: 'new' }, pluginId: 'demo' }, 'old / demo → new'],
        ['RENEWAL', {}, '社区撤销清单'],
    ]) {
        let ref = head, message;
        const call = (endpoint, options = {}) => {
            if (endpoint === prefix) return repo;
            if (endpoint === prefix + '/branches/master') return { commit: { sha: base } };
            if (endpoint === prefix + '/pulls/7') return { number: 7, user: { id: 101, type: 'User' }, head: { sha: ref, repo, ref: 'community/request' },
                base: { sha: base, repo, ref: 'master' }, state: 'open', merged: false, draft: false };
            if (endpoint === prefix + '/git/blobs' || endpoint === prefix + '/git/trees') return { sha: generated };
            if (endpoint === prefix + '/git/commits/' + head) return { tree: { sha: base } };
            if (endpoint === prefix + '/git/commits') { message = options.body.message; return { sha: generated }; }
            if (endpoint === prefix + '/git/refs/heads/community/request') { ref = options.body.sha; return {}; }
            if (endpoint === prefix + '/git/ref/heads/community/request') return { object: { sha: ref } };
            throw new Error('Unexpected request ' + endpoint);
        };
        const automatic = ['YANK', 'UNYANK', 'REVOKE'].includes(operation);
        await appendReviewCommit({ requestId: '1'.repeat(64), baseSha: base, headSha: head, prNumber: 7, operation, files: [],
            appliedAt: '2026-01-02T00:00:00Z', reviewContext: { checked }, ...(automatic ? { authorization: 'SIGNED_OWNER' } : {}) }, {}, call);
        assert.equal(message.split('\n')[0], `chore(community): ${automatic ? '处理已签名的' : '完成'} ${operation} 请求${automatic ? '' : '审核'}：${subject}`);
    }
});
