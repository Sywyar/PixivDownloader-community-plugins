import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareSubmission } from '../submission-sdk.mjs';
import { createResultPull, checkResult, makeReceipt, receiptPath, receiptExpired } from '../apply-result.mjs';
import { encoded, refreshIdentity } from '../apply-generation.mjs';
import { hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';

test('真实 Git 结果 PR 可恢复丢失响应，精确核对字节、前序状态及当前审核', async () => {
    const sdk = prepareSubmission(), directory = path.join(sdk.workspace, 'repository'); fs.mkdirSync(directory);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
    const git = (args, input, extra = {}) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, input, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', '-q', '-b', 'master']);
    const sourceFile = `version-status-requests/101/demo/2.3.4/${'a'.repeat(64)}.json`;
    const blob = git(['hash-object', '-w', '--stdin'], encoded({ requestId: 'a'.repeat(64) }));
    git(['update-index', '--add', '--cacheinfo', '100644', blob, sourceFile]);
    const baseline = encoded({ sequence: 1 });
    git(['update-index', '--add', '--cacheinfo', '100644', git(['hash-object', '-w', '--stdin'], baseline), 'generated/current.json']);
    const source = git(['commit-tree', git(['write-tree'])], 'Original request\n');
    git(['update-ref', 'refs/heads/master', source]);
    const owner = { id: Number(policy.repositoryOwnerId), type: 'User', login: policy.repository.split('/')[0], role_name: 'admin' };
    const repo = { id: Number(policy.repositoryId), full_name: policy.repository, owner, default_branch: policy.defaultBranch, archived: false, private: false, permissions: { admin: true } };
    const original = { number: 7, user: { id: 101, type: 'User' }, head: { sha: source, repo }, base: { sha: source, ref: 'master', repo },
        changed_files: 1, merged: true, merge_commit_sha: source, state: 'closed', draft: false };
    const version = { checked: { operation: 'YANK', requestSha256: 'a'.repeat(64), pr: { head: source, base: source, user: { id: '101', type: 'User' } } } };
    const state = { raw: file => file === 'generated/current.json' ? baseline : null };
    const revocations = ['revocations.json', encoded({ nextUpdate: new Date(Date.now() + 86400000).toISOString() })];
    let made = makeReceipt({ requestId: 'a'.repeat(64), operation: 'YANK', pr: original, current: source, run: { id: 11, run_attempt: 1 }, appliedAt: '2026-01-02T00:00:00Z',
        writes: new Map([['generated/current.json', encoded({ sequence: 2 })], revocations]), state, releases: [], reviewContext: version });
    let pointer = { schemaVersion: 1, releaseId: '501', size: made.bytes.length, sha256: hash(made.bytes) };
    const proofBytes = Buffer.from('{}'), assets = [{ id: 601, name: 'publication.json', size: made.bytes.length, digest: 'sha256:' + hash(made.bytes), state: 'uploaded' },
        { id: 602, name: 'publication-attestation.json', size: proofBytes.length, digest: 'sha256:' + hash(proofBytes), state: 'uploaded' }];
    const requests = [], refs = new Map();
    let current = source, lostRef = true, lostPr = true, approved = true;
    const call = (endpoint, options = {}) => {
        const route = endpoint.split('?')[0], body = options.body;
        if (options.method === 'POST') {
            if (route === `${prefix}/git/blobs`) return { sha: git(['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')) };
            if (route === `${prefix}/git/trees`) {
                git(['read-tree', body.base_tree]);
                for (const file of body.tree) git(['update-index', '--add', '--cacheinfo', file.mode, file.sha, file.path]);
                return { sha: git(['write-tree']) };
            }
            if (route === `${prefix}/git/commits`) return { sha: git(['commit-tree', body.tree, ...body.parents.flatMap(parent => ['-p', parent])], body.message,
                { GIT_AUTHOR_DATE: body.author.date, GIT_COMMITTER_DATE: body.committer.date, GIT_AUTHOR_NAME: body.author.name, GIT_COMMITTER_NAME: body.committer.name,
                    GIT_AUTHOR_EMAIL: body.author.email, GIT_COMMITTER_EMAIL: body.committer.email }) };
            if (route === `${prefix}/git/refs`) {
                assert.equal(refs.has(body.ref), false); refs.set(body.ref, body.sha); git(['update-ref', body.ref, body.sha]);
                if (lostRef) { lostRef = false; throw new Error('REF_RESPONSE_LOST'); } return {};
            }
            if (route === `${prefix}/pulls`) {
                const pr = { number: 8 + requests.length, id: 800 + requests.length, user: owner, head: { repo, sha: refs.get('refs/heads/' + body.head), ref: body.head },
                    base: { repo, sha: source, ref: 'master' }, state: 'open', merged: false, draft: body.draft, changed_files: made.value.files.length + 1 };
                requests.push(pr); if (lostPr) { lostPr = false; throw new Error('PR_RESPONSE_LOST'); } return structuredClone(pr);
            }
            throw new Error('Unexpected mutation ' + route);
        }
        if (route === prefix) return repo;
        if (route === 'user') return owner;
        if (route === `${prefix}/branches/master`) return { commit: { sha: current } };
        if (route === `${prefix}/pulls`) {
            const branch = new URL('https://api.github.com/' + endpoint).searchParams.get('head').split(':').slice(1).join(':');
            return [structuredClone(requests.filter(pr => pr.head.ref === branch))];
        }
        if (route === `${prefix}/pulls/7`) return original;
        if (/\/pulls\/\d+$/u.test(route)) return structuredClone(requests.find(pr => String(pr.number) === route.split('/').at(-1)));
        if (route === `${prefix}/pulls/7/files`) return [[{ filename: sourceFile, status: 'added', sha: blob }]];
        if (/\/pulls\/\d+\/files$/u.test(route)) return [[...made.value.files.map(file => ({ filename: file.path, status: file.before ? 'modified' : 'added' })), { filename: receiptPath(made.value.requestId), status: 'added' }]];
        if (route.includes('/git/matching-refs/heads/')) {
            const ref = route.slice(route.indexOf('/heads/') + 1); return [[...refs].filter(([name]) => name === 'refs/' + ref).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }))];
        }
        if (route.includes('/git/commits/')) return { tree: { sha: git(['rev-parse', route.split('/').at(-1) + '^{tree}']) } };
        if (route.includes('/git/trees/')) return { truncated: false, tree: git(['ls-tree', '-r', '-l', route.split('/').at(-1)]).split('\n').filter(Boolean).map(line => {
            const [, mode, type, sha, size, file] = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(line); return { mode, type, sha, size: Number(size), path: file };
        }) };
        if (route.includes('/git/blobs/')) {
            const sha = route.split('/').at(-1), bytes = execFileSync('git', ['-C', directory, 'cat-file', 'blob', sha], { windowsHide: true });
            return { sha, size: bytes.length, content: bytes.toString('base64'), encoding: 'base64' };
        }
        if (route.endsWith('/check-runs')) return [{ total_count: 4, check_runs: policy.requiredContexts.map((name, index) => ({ id: 91 + index, name,
            app: policy.gateApp, head_sha: source, external_id: '91:1:7', status: 'completed', conclusion: 'success' })) }];
        if (route === `${prefix}/collaborators`) return [[owner]];
        if (route === `${prefix}/pulls/7/reviews`) return [[{ id: 81, user: owner, state: approved ? 'APPROVED' : 'CHANGES_REQUESTED', commit_id: source,
            submitted_at: '2026-01-01T00:00:00Z', pull_request_url: `https://api.github.com/${prefix}/pulls/7` }]];
        if (route.endsWith('/community-review-decision.yml/runs')) return [{ total_count: 0, workflow_runs: [] }];
        if (route === `${prefix}/releases/501`) return { id: 501, tag_name: `operation/${made.value.requestId}/11-1` };
        if (route === `${prefix}/releases/501/assets`) return [assets];
        throw new Error('Unexpected request ' + endpoint);
    };
    const pr = createResultPull(made.value, pointer, call);
    assert.equal(pr.draft, true); assert.equal(requests.length, 1); assert.equal(refs.size, 1);
    assert.equal(git(['rev-parse', 'master']), source);
    assert.equal(createResultPull(made.value, pointer, call).number, pr.number);
    const options = { call, readGit: args => git(args), verify: () => ({ sourceRepositoryDigest: source }),
        download: (endpoint, file) => fs.writeFileSync(file, endpoint.endsWith('/601') ? made.bytes : proofBytes, { flag: 'wx' }) };
    assert.equal((await checkResult(pr.number, sdk, source, options)).receipt.requestId, made.value.requestId);
    assert.equal(receiptExpired(made.value), false);
    assert.equal(receiptExpired(made.value, Date.now() + 86400001), true);
    approved = false;
    await assert.rejects(checkResult(pr.number, sdk, source, options), /PUBLICATION_REVIEW_REQUIRED/);
    approved = true; current = 'e'.repeat(40);
    assert.throws(() => createResultPull(made.value, pointer, call), /APPLY_BASE_CHANGED/);
    current = source; requests[0].state = 'closed';
    const replacement = createResultPull(made.value, pointer, call);
    assert.notEqual(replacement.number, pr.number); assert.notEqual(replacement.head.ref, pr.head.ref);
    const refreshOptions = { requestId: refreshIdentity(state), operation: 'REFRESH', current: source, run: { id: 11, run_attempt: 1 },
        appliedAt: '2026-01-03T00:00:00Z', state, releases: [], reviewContext: { checked: { operation: 'REFRESH' } } };
    const refresh = async writes => {
        made = makeReceipt({ ...refreshOptions, writes });
        pointer = { ...pointer, size: made.bytes.length, sha256: hash(made.bytes) };
        assets[0] = { ...assets[0], size: made.bytes.length, digest: 'sha256:' + hash(made.bytes) };
        const pr = createResultPull(made.value, pointer, call);
        requests.find(row => row.number === pr.number).state = 'open';
        return checkResult(pr.number, sdk, source, options);
    };
    approved = false;
    assert.equal((await refresh(new Map([['generated/current.json', encoded({ sequence: 2 })], revocations]))).receipt.operation, 'REFRESH');
    requests.at(-1).state = 'closed';
    await assert.rejects(refresh(new Map([['publishers/101/changed.json', encoded({ changed: true })], revocations])), /REFRESH_RESULT_INVALID/);
    requests.at(-1).state = 'closed';
    await assert.rejects(refresh(new Map([['generated/current.json', encoded({ sequence: 2 })],
        ['revocations.json', encoded({ nextUpdate: '2000-01-01T00:00:00Z' })]])), /APPLY_RESULT_EXPIRED/);
});
