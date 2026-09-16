import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sourceCandidate, candidateTag, rollingCandidateTag } from '../submission-candidate.mjs';
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
    const publicUrl = name => `https://github.com/${source.name}/releases/download/${release.tag_name}/${name}`;
    const draftUrl = name => `https://github.com/${source.name}/releases/download/untagged-78a7a5fdc81320c954cd/${name}`;
    for (const asset of assets) asset.browser_download_url = draftUrl(asset.name);
    const run = { repository, path: '.github/workflows/candidate.yml', status: 'completed', conclusion: 'success',
        event: 'push', head_sha: source.commit, head_branch: 'main', run_attempt: 1 };
    const store = openProject(projectIdentity('101', '.', 'example'), '201', { home: workspace });
    t.after(() => { store.close(); fs.rmSync(workspace, { recursive: true }); });
    let tag = source.commit; let listed = true; let attempts = 1; let permission = false; let total = 1;
    let tagExists = false; let refError; let commitError; let pollFailure = false, dispatchFailure = false;
    const writes = []; const transfers = [];
    const call = (endpoint, options = {}) => {
        if (options.method === 'PATCH') {
            assert(permission); assert.deepEqual(options.body, { draft: false, prerelease: true, make_latest: 'false' });
            writes.push(endpoint); release.draft = false; tagExists = true;
            for (const asset of assets) asset.browser_download_url = publicUrl(asset.name);
            throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true, method: 'PATCH' });
        }
        if (options.method === 'POST') {
            assert(permission); assert(endpoint.endsWith('/actions/runs/301/rerun'));
            writes.push(endpoint); attempts++;
            if (dispatchFailure) { dispatchFailure = false; throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true }); }
            return null;
        }
        if (endpoint === 'repos/' + source.name) return repository;
        if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: source.commit } };
        if (endpoint.endsWith('/releases?per_page=100')) return [listed ? [{ ...release }] : []];
        if (endpoint.endsWith('/releases/401/assets?per_page=100')) return [structuredClone(assets)];
        if (endpoint.endsWith('/releases/401')) return { ...release };
        if (endpoint.includes('/releases/assets/')) return { ...assets.find(asset => endpoint.endsWith('/' + asset.id)) };
        if (endpoint.includes('/git/ref/tags/')) {
            assert.equal(endpoint, `repos/${source.name}/git/ref/tags/${release.tag_name}`);
            if (refError) throw refError;
            if (!tagExists) throw new Error('GITHUB_NOT_FOUND');
            return { ref: 'refs/tags/' + release.tag_name };
        }
        if (endpoint.includes('/commits/')) {
            if (!tagExists) throw new Error('GITHUB_REQUEST_FAILED');
            if (commitError) throw commitError;
            return { sha: tag };
        }
        if (endpoint.endsWith('/actions/runs/301/attempts/1')) return { ...run };
        if (endpoint.endsWith('/actions/runs/301')) {
            if (pollFailure) { pollFailure = false; throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true }); }
            listed = true; return { ...run, conclusion: 'success', run_attempt: attempts };
        }
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
    let interruptPublic = true;
    const publicDownload = async (url, destination, maximum, expected) => {
        assert.equal(release.draft, false); assert.equal(url, assets[1].browser_download_url);
        if (interruptPublic) { interruptPublic = false; throw Object.assign(new Error('DOWNLOAD_CONNECTION_RESET'), { download: true, retryable: true }); }
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
    assert.equal(prepared.packageUrl, publicUrl(c.artifact.file));
    assert.notEqual(prepared.packageUrl, assets[1].browser_download_url);
    const preview = path.join(workspace, 'preview.jar');
    await prepared.fetch(prepared.packageUrl, preview, bytes.length, { size: bytes.length, sha256: hash(bytes) });
    assert.deepEqual(fs.readFileSync(preview), bytes);
    const packages = transfers.filter(item => item.endsWith('/502')).length;
    await prepare(); assert.equal(transfers.filter(item => item.endsWith('/502')).length, packages);
    await prepared.recheck(); assert.equal(writes.length, 0);
    refError = new Error('GITHUB_REQUEST_FAILED');
    await assert.rejects(prepared.recheck(), /GITHUB_REQUEST_FAILED/u); refError = undefined;
    release.draft = false; await assert.rejects(prepare(), /GITHUB_NOT_FOUND/u); release.draft = true;
    tagExists = true;
    commitError = new Error('GITHUB_NOT_FOUND');
    await assert.rejects(prepared.recheck(), /GITHUB_NOT_FOUND/u); commitError = undefined;
    await prepared.recheck();
    tag = 'b'.repeat(40); await assert.rejects(prepared.recheck(), /CANDIDATE_TAG_CHANGED/u); tag = source.commit;
    run.head_sha = 'b'.repeat(40); await assert.rejects(prepared.recheck(), /CANDIDATE_CI_NOT_PASSED/u); run.head_sha = source.commit;
    assets[1].digest = 'sha256:' + '0'.repeat(64); await assert.rejects(prepared.recheck(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].digest = 'sha256:' + hash(bytes);
    assets[1].browser_download_url = draftUrl(assets[1].name).replace('/owner/source/', '/other/source/');
    await assert.rejects(prepare(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].browser_download_url = draftUrl(assets[1].name).replace('/untagged-', '/different-');
    await assert.rejects(prepare(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].browser_download_url = draftUrl(assets[1].name).replace('78a7a5fdc81320c954cd', '1234');
    await assert.rejects(prepared.recheck(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].browser_download_url = draftUrl(assets[1].name);
    permission = true; await assert.rejects(prepared.beforeWrite(), /DOWNLOAD_CONNECTION_RESET/u);
    assert.equal(writes.length, 1); assert.equal(release.draft, false);
    await prepared.beforeWrite(); await prepared.beforeWrite(); assert.equal(writes.length, 1);
    assert.equal(store.record.receipt.sourcePublished, true);
    assert.deepEqual((await prepare()).actions, []);
    assets[1].browser_download_url = draftUrl(assets[1].name);
    await assert.rejects(prepare(), /CANDIDATE_ASSET_CHANGED/u);
    await assert.rejects(prepared.recheck(), /CANDIDATE_ASSET_CHANGED/u);
    assets[1].browser_download_url = publicUrl(assets[1].name);
    listed = false; run.conclusion = 'failure';
    total = 2; await assert.rejects(prepare(), /GITHUB_PAGINATION_INVALID/u); assert.equal(writes.length, 1); total = 1;
    pollFailure = true; dispatchFailure = true;
    await assert.rejects(prepare(), /GITHUB_REQUEST_FAILED/u); assert.equal(writes.length, 2);
    const deadline = context.recoveredCandidates.get('101/301').deadline;
    await assert.rejects(prepare(), /GITHUB_REQUEST_FAILED/u); assert.equal(writes.length, 2);
    assert.equal(context.recoveredCandidates.get('101/301').deadline, deadline);
    await prepare(); assert.equal(writes.length, 2); assert.equal(attempts, 2);
    listed = false; await assert.rejects(prepare(), /CANDIDATE_ARCHIVE_FAILED/u); assert.equal(writes.length, 2);
});

test('滚动草稿只在确认投稿时复制固定候选，中断恢复不覆写，后续 CI 不改变审核字节', async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-rolling-'));
    t.after(() => fs.rmSync(workspace, { recursive: true }));
    const bytes = Buffer.from('verified rolling package');
    const source = { name: 'owner/source', commit: 'a'.repeat(40) };
    const repository = { id: 101, full_name: source.name, default_branch: 'main', owner: { id: 201 } };
    const candidate = { schemaVersion: 1, repositoryId: '101', repository: source.name, sourceCommit: source.commit,
        runId: '301', runAttempt: 1, pluginId: 'example', version: '3.4.5',
        buildProfile: { id: 'maven-java17-v1', projectDir: '.', artifactPath: 'target/plugin.jar' },
        artifact: { file: 'pixivdownload-plugin-example-3.4.5.jar', size: bytes.length, sha256: hash(bytes) } };
    const rolling = { id: 401, tag_name: rollingCandidateTag(candidate), target_commitish: source.commit, prerelease: true, draft: true };
    const releases = [rolling]; const assets = new Map(); const contents = new Map();
    let nextId = 501; let allowed = false; let interrupt = true; let writes = 0;
    const add = (release, name, data) => {
        const asset = { id: nextId++, name, size: data.length, digest: 'sha256:' + hash(data), state: 'uploaded',
            browser_download_url: `https://github.com/${source.name}/releases/download/${release.tag_name}/${name}` };
        assets.set(asset.id, { ...asset, releaseId: release.id }); contents.set(asset.id, data); return asset;
    };
    add(rolling, candidate.artifact.file, bytes); add(rolling, 'source-candidate.json', Buffer.from(JSON.stringify(candidate)));
    const call = (endpoint, { method = 'GET', body } = {}) => {
        if (method !== 'GET') { assert(allowed); writes++; }
        if (method === 'POST') {
            assert.equal(endpoint, `repos/${source.name}/releases`); releases.push({ ...body, id: 402 });
            throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true });
        }
        if (method === 'PATCH') { releases[1].draft = false; return { ...releases[1] }; }
        if (endpoint === `repos/${source.name}`) return repository;
        if (endpoint.endsWith('/releases?per_page=100')) return [structuredClone(releases)];
        if (/\/releases\/[0-9]+\/assets\?/u.test(endpoint)) {
            const releaseId = Number(/\/releases\/([0-9]+)/u.exec(endpoint)[1]);
            return [structuredClone([...assets.values()].filter(a => a.releaseId === releaseId))];
        }
        if (/\/releases\/assets\/[0-9]+$/u.test(endpoint)) return { ...assets.get(Number(endpoint.split('/').at(-1))) };
        if (/\/releases\/[0-9]+$/u.test(endpoint)) return { ...releases.find(r => r.id === Number(endpoint.split('/').at(-1))) };
        if (endpoint.includes('/git/ref/tags/')) {
            const release = releases.find(r => endpoint.endsWith('/' + r.tag_name));
            if (!release || release.draft) throw new Error('GITHUB_NOT_FOUND');
            return { ref: 'refs/tags/' + release.tag_name };
        }
        if (endpoint.includes('/commits/')) return { sha: source.commit };
        if (endpoint.endsWith('/actions/runs/301/attempts/1')) return { repository, path: '.github/workflows/candidate.yml', status: 'completed',
            conclusion: 'success', event: 'push', head_sha: source.commit, head_branch: 'main', run_attempt: 1 };
        throw new Error(endpoint);
    };
    const transfer = (endpoint, file, maximum, expected) => {
        const data = contents.get(Number(endpoint.split('/').at(-1)));
        assert(data.length <= maximum); assert.deepEqual(expected, { size: data.length, sha256: hash(data) });
        fs.writeFileSync(file, data, { flag: 'wx' });
    };
    const upload = (prefix, releaseId, file, name) => {
        assert(allowed); assert.equal(prefix, 'repos/' + source.name); assert.equal(releaseId, '402'); writes++;
        if (interrupt && name === 'source-candidate.json') throw Object.assign(new Error('GITHUB_TIMEOUT'), { github: true });
        add(releases[1], name, fs.readFileSync(file));
        throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true });
    };
    const publicDownload = async (url, _file, _maximum, expected) => {
        assert.equal(url, `https://github.com/${source.name}/releases/download/${candidateTag(candidate)}/${candidate.artifact.file}`);
        assert.equal(releases[1].draft, false); assert.equal(expected.sha256, hash(bytes));
    };
    const context = { call, ui: { select() { throw new Error('NO_DUPLICATE_CHOICE'); } }, sdk: { workspace,
        invoke(input) {
            if (input.command === 'candidate') return JSON.parse(fs.readFileSync(input.file, 'utf8'));
            if (input.command === 'limits') return { maxArchiveBytes: 192 * 1024 * 1024 };
            return { pluginId: candidate.pluginId, version: candidate.version, size: bytes.length, sha256: hash(bytes) };
        } } };
    const prepare = extra => sourceCandidate({ ...context, ...extra }, source, { projectDir: '.' }, candidate.buildProfile.id, transfer, publicDownload, upload);
    const first = await prepare(); assert.equal(writes, 0); assert.equal(first.sourceRelease.tag, candidateTag(candidate));
    const original = structuredClone(rolling);
    rolling.target_commitish = 'b'.repeat(40); await assert.rejects(first.recheck(), /CANDIDATE_RELEASE_CHANGED/u);
    rolling.target_commitish = source.commit;
    allowed = true; await assert.rejects(first.beforeWrite(), /GITHUB_TIMEOUT/u);
    assert.equal(releases.length, 2); assert.equal([...assets.values()].filter(a => a.releaseId === 402).length, 1);
    interrupt = false;
    const second = await prepare(); await second.beforeWrite(); await second.beforeWrite();
    assert.deepEqual(rolling, original); assert.equal(releases.length, 2);
    assert.equal([...assets.values()].filter(a => a.releaseId === 402).length, 2);
    rolling.target_commitish = 'b'.repeat(40);
    for (const asset of [...assets.values()].filter(a => a.releaseId === 401)) { assets.delete(asset.id); contents.delete(asset.id); }
    const resumed = await prepare({ resumeCandidateId: '401', resumeCandidateTag: first.sourceRelease.tag });
    assert.equal(resumed.sourceRelease.id, '402'); assert.equal(resumed.packageUrl, first.packageUrl);
    assert.deepEqual(resumed.actions, []); await resumed.recheck();
    const frozenPackage = [...assets.values()].find(a => a.releaseId === 402 && a.name === candidate.artifact.file);
    assert.deepEqual(contents.get(frozenPackage.id), bytes);
    const frozenMetadata = [...assets.values()].find(a => a.releaseId === 402 && a.name === 'source-candidate.json');
    frozenMetadata.digest = 'sha256:' + '0'.repeat(64);
    await assert.rejects(resumed.recheck(), /CANDIDATE_ASSET_CHANGED/u);
});
