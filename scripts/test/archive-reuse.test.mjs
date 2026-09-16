import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archiveCandidate } from '../archive.mjs';
import { archivedCandidates, readArchivedCandidate } from '../archive-read.mjs';
import { storeArchiveProof } from '../archive-proof.mjs';
import { candidateIdentity, candidateSlot, buildPath } from '../candidate.mjs';
import { root, hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';

function fixture(t) {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const workspace = fs.mkdtempSync(path.join(root, 'target/draft-reuse-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const current = 'b'.repeat(40), releases = [], pulls = new Map(), runs = new Map(), stored = new Map(), writes = [];
    let nextAsset = 100, failUpload = false;
    const sdk = { workspace, invoke: () => ({ maxArchiveBytes: 1024 * 1024 }) };
    const create = (number = 7, run = '31', head = 'a'.repeat(40)) => {
        const directory = fs.mkdtempSync(path.join(workspace, 'input-'));
        fs.writeFileSync(path.join(directory, 'plugin.jar'), 'package-' + run);
        fs.writeFileSync(path.join(directory, 'source.zip'), 'source-' + run);
        fs.writeFileSync(path.join(directory, 'review-evidence.zip'), 'report-' + run);
        const files = ['plugin.jar', 'source.zip', 'review-evidence.zip'].map(file => {
            const bytes = fs.readFileSync(path.join(directory, file)); return { path: file, size: bytes.length, sha256: hash(bytes) };
        });
        const checked = { validation: 'STATIC_VALIDATED', sourceRepositoryId: '201', publisherKeyFingerprint: 'f'.repeat(64),
            pr: { number, head, base: current, headId: '301' }, owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
            submission: { pluginId: 'demo', version: '2.3.4', source: { commit: 'c'.repeat(40), archive: files[1] } },
            submissionSha256: hash(Buffer.from(run)), descriptor: {}, package: { size: files[0].size, sha256: files[0].sha256 },
            packageFile: path.join(directory, 'plugin.jar') };
        const inputs = { report: run };
        const candidate = { ...checked, schemaVersion: 1, state: 'PENDING_REVIEW', workflowPath: buildPath,
            workflowSha: current, repositoryId: policy.repositoryId, repositoryOwnerId: policy.repositoryOwnerId,
            runId: run, runAttempt: 1, inputs, inputSha256: hash(Buffer.from(JSON.stringify(inputs))), files, evidence: [] };
        delete candidate.packageFile;
        fs.writeFileSync(path.join(directory, 'candidate.json'), JSON.stringify(candidate) + '\n');
        pulls.set(number, { number, state: 'open', merged: false, user: { type: 'User', id: 101 },
            head: { sha: head, repo: { id: 301 } }, base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } } });
        runs.set(run, candidate);
        return { checked, candidate, directory };
    };
    const call = (endpoint, options = {}) => {
        const route = endpoint.split('?')[0];
        const release = releases.find(release => route === `${prefix}/releases/${release.id}` || route === `${prefix}/releases/${release.id}/assets`);
        if (options.method && options.method !== 'GET') {
            writes.push({ endpoint, ...options });
            if (route === `${prefix}/releases` && options.method === 'POST') {
                const row = { ...options.body, id: releases.length + 1, assets: [], published_at: null,
                    created_at: new Date().toISOString(), html_url: 'https://github.com/example/draft' };
                releases.push(row); return structuredClone(row);
            }
            if (route.includes('/releases/assets/') && options.method === 'DELETE') {
                const assetId = Number(route.split('/').at(-1));
                for (const row of releases) row.assets = row.assets.filter(asset => asset.id !== assetId);
                stored.delete(assetId); return null;
            }
            if (release && options.method === 'PATCH') { Object.assign(release, options.body); return structuredClone(release); }
            assert.fail('unexpected write ' + endpoint);
        }
        if (route === prefix) return { permissions: { push: true } };
        if (route === `${prefix}/releases`) return [structuredClone(releases)];
        if (release) return structuredClone(route.endsWith('/assets') ? [release.assets] : release);
        if (route.includes('/pulls/')) return structuredClone(pulls.get(Number(route.split('/').at(-1))));
        if (route.includes('/actions/runs/')) {
            const runId = route.split('/runs/')[1].split('/')[0], candidate = runs.get(runId);
            if (route.endsWith('/jobs')) return [{ total_count: 1, jobs: [{ id: Number(runId), run_id: Number(runId), name: 'Build and scan version',
                conclusion: 'success', steps: [{ name: 'Bind protected build execution', conclusion: 'success' }] }] }];
            return { id: Number(runId), run_attempt: candidate.runAttempt, workflow_id: 51, event: 'pull_request_target',
                path: buildPath, status: 'completed', conclusion: 'success', repository: { id: policy.repositoryId }, head_repository: { id: policy.repositoryId } };
        }
        if (route.endsWith('/workflows/51')) return { id: 51, path: buildPath };
        if (route.endsWith('/logs')) {
            const candidate = runs.get(route.split('/jobs/')[1].split('/')[0]);
            return Buffer.from('2026-01-01T00:00:00Z COMMUNITY_BUILD_EXECUTION ' + JSON.stringify({ ...candidate,
                prNumber: candidate.pr.number, headSha: candidate.pr.head }) + '\n');
        }
        assert.fail('unexpected read ' + endpoint);
    };
    const upload = (releaseId, file, name) => {
        if (failUpload) { failUpload = false; throw new Error('INTERRUPTED_UPLOAD'); }
        const bytes = fs.readFileSync(file), asset = { id: nextAsset++, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) };
        releases.find(row => String(row.id) === String(releaseId)).assets.push(asset); stored.set(asset.id, bytes);
        return structuredClone(asset);
    };
    const download = async (endpoint, file, maximum, expected) => {
        const bytes = stored.get(Number(endpoint.split('/').at(-1)));
        assert(bytes.length <= maximum); assert.equal(bytes.length, expected.size); assert.equal(hash(bytes), expected.sha256);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
    };
    const options = { call, upload, download, readGit: () => 'protected', verify: () => ({}) };
    const archive = value => archiveCandidate(sdk, value.candidate, value.directory, current, { ...options, check: async () => value.checked });
    const proof = async value => {
        const file = path.join(value.directory, 'proof.json');
        fs.writeFileSync(file, '{}');
        return storeArchiveProof('1', path.join(value.directory, 'candidate.json'), file, current, options);
    };
    return { sdk, current, create, archive, proof, options, releases, pulls, writes, stored,
        interrupt() { failUpload = true; } };
}

test('同一发布身份跨提交和关闭后重新投稿复用草稿；中断不保留旧证明', async t => {
    const f = fixture(t), first = f.create();
    await f.archive(first); await f.proof(first);
    const slot = f.releases[0].tag_name;
    assert.equal(slot, candidateSlot(first.candidate));
    assert.deepEqual(archivedCandidates(first.checked, f.options.call).map(row => row.id), [1]);
    const second = f.create(7, '32', 'd'.repeat(40));
    f.interrupt();
    await assert.rejects(f.archive(second), /INTERRUPTED_UPLOAD/);
    assert.equal(f.releases.length, 1);
    assert(!f.releases[0].assets.some(asset => asset.name === 'archive-attestation.json'));
    await assert.rejects(readArchivedCandidate(f.sdk, f.releases[0], f.current, f.options), /CANDIDATE_ARCHIVE_PENDING/);
    await f.archive(second); await f.proof(second);
    await assert.rejects(f.proof(first), /CANDIDATE_RELEASE_CHANGED/);
    const before = f.writes.length;
    await f.archive(second);
    assert.equal(f.writes.length, before);
    const third = f.create(8, '33');
    await assert.rejects(f.archive(third), /CANDIDATE_SLOT_IN_USE/);
    assert.equal(f.writes.length, before);
    f.pulls.get(7).state = 'closed';
    await f.archive(third); await f.proof(third);
    assert.equal(f.releases.length, 1); assert.equal(f.releases[0].tag_name, slot);
    const manifest = f.releases[0].assets.find(asset => asset.name === 'candidate.json');
    assert.equal(JSON.parse(f.stored.get(manifest.id)).pr.number, 8);
    assert.equal(f.releases[0].assets.length, 5);
    assert.equal(candidateSlot({ ...third.candidate, owner: { ...third.candidate.owner, accountId: '102' } }) === slot, false);
    assert.equal(candidateSlot({ ...third.candidate, submission: { ...third.candidate.submission, version: '2.3.5' } }) === slot, false);
});

test('旧 PR 草稿就地迁移，过时构建和已发布资产保持不变', async t => {
    const f = fixture(t), first = f.create();
    await f.archive(first); await f.proof(first);
    f.releases[0].tag_name = candidateIdentity(first.candidate);
    f.releases[0].body = 'Pending review.';
    assert.deepEqual(archivedCandidates(first.checked, f.options.call).map(row => row.id), [1]);
    await f.archive(first);
    assert.equal(f.releases.length, 1); assert.equal(f.releases[0].tag_name, candidateSlot(first.candidate));
    const next = f.create(7, '32');
    await f.archive(next); await f.proof(next);
    const before = f.writes.length;
    await assert.rejects(f.archive(first), /CANDIDATE_RUN_SUPERSEDED/);
    assert.equal(f.writes.length, before);
    f.releases[0].draft = false; f.releases[0].published_at = '2026-01-01T00:00:00Z';
    await assert.rejects(f.archive(next), /CANDIDATE_ALREADY_PUBLISHED/);
    assert.equal(f.writes.length, before);
});
