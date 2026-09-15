import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sourceCandidate, candidateTag } from '../submission-candidate.mjs';
import { openProject, projectIdentity } from '../submission-state.mjs';
import { hash } from '../sdk.mjs';

test('源码草稿以固定提交和原始附件恢复，发布前重新核验 CI、标签和字节', async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-candidate-'));
    const bytes = Buffer.from('candidate bytes');
    const source = { name: 'owner/source', commit: 'a'.repeat(40) };
    const repository = { id: 101, full_name: source.name, default_branch: 'main', owner: { id: 201 } };
    const c = { schemaVersion: 1, repositoryId: '101', repository: source.name, sourceCommit: source.commit,
        runId: '301', runAttempt: 1, pluginId: 'example', version: '2.3.4-rc.2',
        buildProfile: { id: 'maven-java17-v1', projectDir: '.', artifactPath: 'target/plugin.jar' },
        artifact: { file: 'pixivdownload-plugin-example-2.3.4-rc.2.jar', size: bytes.length, sha256: hash(bytes) } };
    const release = { id: 401, tag_name: candidateTag(c), target_commitish: source.commit, prerelease: true, draft: true };
    const metadata = Buffer.from(JSON.stringify(c));
    const assets = [{ id: 501, name: 'source-candidate.json', size: metadata.length, digest: 'sha256:' + hash(metadata), state: 'uploaded' },
        { id: 502, name: c.artifact.file, size: bytes.length, digest: 'sha256:' + hash(bytes), state: 'uploaded',
            browser_download_url: `https://github.com/${source.name}/releases/download/${release.tag_name}/${c.artifact.file}` }];
    const run = { repository, path: '.github/workflows/candidate.yml', status: 'completed', conclusion: 'success',
        event: 'push', head_sha: source.commit, head_branch: 'main', run_attempt: 1 };
    const store = openProject(projectIdentity('101', '.', 'example'), '201', { home: workspace });
    t.after(() => { store.close(); fs.rmSync(workspace, { recursive: true }); });
    let tag = source.commit; let listed = true; let attempts = 1; let permission = false; let total = 1;
    const writes = []; const transfers = [];
    const call = (endpoint, options = {}) => {
        if (options.method === 'PATCH') {
            assert(permission); assert.deepEqual(options.body, { draft: false, prerelease: true, make_latest: 'false' });
            writes.push(endpoint); release.draft = false; return { ...release };
        }
        if (options.method === 'POST') {
            assert(permission); assert(endpoint.endsWith('/actions/runs/301/rerun'));
            writes.push(endpoint); listed = true; attempts++; return null;
        }
        if (endpoint === 'repos/' + source.name) return repository;
        if (endpoint.endsWith('/releases?per_page=100')) return [listed ? [{ ...release }] : []];
        if (endpoint.endsWith('/releases/401/assets?per_page=100')) return [structuredClone(assets)];
        if (endpoint.endsWith('/releases/401')) return { ...release };
        if (endpoint.includes('/releases/assets/')) return { ...assets.find(asset => endpoint.endsWith('/' + asset.id)) };
        if (endpoint.includes('/commits/')) return { sha: tag };
        if (endpoint.endsWith('/actions/runs/301/attempts/1')) return { ...run };
        if (endpoint.endsWith('/actions/runs/301')) return { ...run, conclusion: 'success', run_attempt: attempts };
        if (endpoint.includes('/attempts/1/jobs?')) return [{ total_count: 1, jobs: [{ id: 601, run_id: 301, head_sha: source.commit,
            name: `Build candidate (${hash(Buffer.from('.')).slice(0, 16)})`, status: 'completed', conclusion: 'success' }] }];
        if (endpoint.includes('/actions/runs?')) return [{ total_count: total, workflow_runs: [{ ...run, id: 301 }] }];
        throw new Error(endpoint);
    };
    const transfer = (endpoint, destination, maximum, expected) => {
        const value = endpoint.endsWith('/501') ? metadata : bytes;
        assert(value.length <= maximum);
        if (expected) assert.deepEqual(expected, { size: value.length, sha256: hash(value) });
        transfers.push(endpoint); fs.writeFileSync(destination, value, { flag: 'wx' });
    };
    const publicDownload = async (url, destination, maximum, expected) => {
        assert.equal(release.draft, false); assert.equal(url, assets[1].browser_download_url);
        transfer(url, destination, maximum, expected);
    };
    const context = { call, store, bindProject(...parts) { assert.deepEqual(parts, ['101', '.', 'example']); },
        ui: { text: key => key, confirm: async () => permission, task: async (_key, work) => work() },
        sdk: { workspace, invoke(input) {
            if (input.command === 'candidate') return JSON.parse(fs.readFileSync(input.file, 'utf8'));
            if (input.command === 'limits') return { maxArchiveBytes: 192 * 1024 * 1024 };
            assert.equal(input.command, 'inspect'); assert.deepEqual(fs.readFileSync(input.file), bytes);
            return { pluginId: c.pluginId, version: c.version, size: bytes.length, sha256: hash(bytes) };
        } } };
    const prepare = () => sourceCandidate(context, source, { projectDir: '.' }, c.buildProfile.id, transfer, publicDownload);
    const prepared = await prepare(); assert.equal(writes.length, 0);
    const preview = path.join(workspace, 'preview.jar');
    await prepared.fetch(prepared.packageUrl, preview, bytes.length, { size: bytes.length, sha256: hash(bytes) });
    assert.deepEqual(fs.readFileSync(preview), bytes);
    const packages = transfers.filter(item => item.endsWith('/502')).length;
    await prepare(); assert.equal(transfers.filter(item => item.endsWith('/502')).length, packages);
    tag = 'b'.repeat(40); await assert.rejects(prepared.recheck(), /CANDIDATE_TAG_CHANGED/u); tag = source.commit;
    run.head_sha = 'b'.repeat(40); await assert.rejects(prepared.recheck(), /CANDIDATE_CI_NOT_PASSED/u); run.head_sha = source.commit;
    assets[1].digest = 'sha256:' + '0'.repeat(64); await assert.rejects(prepared.recheck(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].digest = 'sha256:' + hash(bytes);
    permission = true; await prepared.beforeWrite(); await prepared.beforeWrite(); assert.equal(writes.length, 1);
    assert.equal(store.record.receipt.sourcePublished, true);
    assert.deepEqual((await prepare()).actions, []);
    listed = false; run.conclusion = 'failure';
    total = 2; await assert.rejects(prepare(), /GITHUB_PAGINATION_INVALID/u); assert.equal(writes.length, 1); total = 1;
    await prepare(); assert.equal(writes.length, 2); assert.equal(attempts, 2);
    listed = false; await assert.rejects(prepare(), /CANDIDATE_ARCHIVE_FAILED/u); assert.equal(writes.length, 2);
});
