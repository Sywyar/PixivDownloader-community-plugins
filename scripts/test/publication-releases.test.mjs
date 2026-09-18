import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promoteReleases, releaseBody, releaseStatus, finalizeReleases } from '../publication-releases.mjs';
import { prepareSubmission } from './local-sdk.mjs';
import { publicationCertificate, publicationPath, statusPath, verifyPublicationProof } from '../archive-proof.mjs';
import { makeReceipt, readReceipt } from '../apply-result.mjs';
import { encoded, formalTag, packageName } from '../apply-generation.mjs';
import { hash, root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';

function archiveFixture(t) {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const workspace = fs.mkdtempSync(path.join(root, 'target/publication-test-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const bodies = new Map(), assets = [];
    const release = { id: 501, draft: true, published_at: null, tag_name: 'candidate/original', target_commitish: 'a'.repeat(40) };
    let writes = 0, losePatch = false, tag = null;
    const upload = (_id, file, name) => {
        const bytes = fs.readFileSync(file), id = 701 + assets.length;
        const value = { id, name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded' };
        bodies.set(String(id), bytes); assets.push(value); writes++; return structuredClone(value);
    };
    const download = (endpoint, file, max, expected) => {
        const bytes = bodies.get(endpoint.split('/').at(-1));
        assert.ok(bytes.length <= max); assert.equal(bytes.length, expected.size); assert.equal(hash(bytes), expected.sha256);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
    };
    const call = (endpoint, options = {}) => {
        if (endpoint === `${prefix}/releases/501`) {
            if (options.method === 'PATCH') {
                Object.assign(release, options.body, { published_at: '2026-01-01T00:00:00Z' });
                tag = { ref: 'refs/tags/' + release.tag_name, object: { type: 'commit', sha: release.target_commitish } }; writes++;
                if (losePatch) { losePatch = false; throw new Error('RESPONSE_LOST'); }
            }
            return structuredClone(release);
        }
        if (endpoint.startsWith(`${prefix}/releases/501/assets?`)) return [structuredClone(assets)];
        if (endpoint.startsWith(`${prefix}/git/matching-refs/tags/`)) return [tag ? [structuredClone(tag)] : []];
        throw new Error('Unexpected request ' + endpoint);
    };
    const fetch = (url, file, max, expected) => {
        assert.equal(url, `https://github.com/${policy.repository}/releases/download/${release.tag_name}/package.jar`);
        return download(`${prefix}/releases/assets/701`, file, max, expected);
    };
    return { workspace, bodies, assets, release, upload, download, fetch, call, writes: () => writes, loseResponse: () => { losePatch = true; } };
}

test('候选提升为正式 Release 后响应丢失可恢复，原资产和签名不覆盖', async t => {
    const f = archiveFixture(t), packageBytes = Buffer.from('frozen package');
    const file = path.join(f.workspace, 'package.jar'); fs.writeFileSync(file, packageBytes);
    f.upload(501, file, 'package.jar');
    const receipt = { releases: [{ id: 501, originalTag: f.release.tag_name, tag: 'original/demo-v2.3.4-rc.9', targetCommit: 'b'.repeat(40),
        packageName: 'package.jar', packageSize: packageBytes.length, packageSha256: hash(packageBytes), originalAssets: structuredClone(f.assets),
        reviewBytes: encoded({ reviewed: true }).toString('base64'), signature: { value: 'community signature' }, name: 'original / demo-v2.3.4-rc.9',
        owner: { publisherId: 'original', accountId: '101', accountType: 'User' }, sourceCommit: 'c'.repeat(40), version: '2.3.4-rc.9' }] };
    receipt.headSha = 'a'.repeat(40); receipt.baseSha = 'c'.repeat(40);
    const completion = { receipt, pr: { merged: true, state: 'closed', head: { sha: 'd'.repeat(40) }, merge_commit_sha: 'b'.repeat(40) },
        commit: { sha: 'd'.repeat(40), parents: [{ sha: receipt.headSha }] },
        merge: { sha: 'b'.repeat(40), parents: [{ sha: receipt.baseSha }, { sha: 'd'.repeat(40) }] } };
    let confirmations = 0, blocked = true, authorizations = 0;
    const transport = { ...f, authorize: () => { authorizations++; if (blocked) throw new Error('KEY_DECLARED_COMPROMISED'); },
        confirm: (_expected, file) => { assert.deepEqual(fs.readFileSync(file), packageBytes); confirmations++; } };
    await assert.rejects(promoteReleases({ ...completion, pr: { ...completion.pr, merged: false } }, f.workspace, transport), /REVIEW_MERGE_CHANGED/);
    assert.equal(f.release.draft, true);
    await assert.rejects(promoteReleases(completion, f.workspace, transport), /KEY_DECLARED_COMPROMISED/);
    assert.equal(f.release.draft, true);
    blocked = false;
    f.loseResponse();
    await promoteReleases(completion, f.workspace, transport);
    assert.equal(confirmations, 2);
    assert.equal(f.release.draft, false); assert.equal(f.release.prerelease, true);
    assert.equal(f.release.tag_name, receipt.releases[0].tag); assert.deepEqual(f.bodies.get('701'), packageBytes);
    blocked = true;
    const authorized = authorizations;
    const count = f.writes(); await promoteReleases(completion, f.workspace, transport); assert.equal(f.writes(), count);
    assert.equal(authorizations, authorized);
    f.assets[0].id = 999;
    await assert.rejects(promoteReleases(completion, f.workspace, transport), /PUBLICATION_ASSET_CHANGED/);
    assert.equal(f.writes(), count);
});

test('已合并整代状态驱动 Release 更新，响应丢失回读且只读检查不写入', async t => {
    const f = archiveFixture(t), sdk = prepareSubmission(), current = 'b'.repeat(40), records = new Map();
    const source = 'a'.repeat(40), head = 'c'.repeat(40), generated = 'd'.repeat(40);
    const vector = name => JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/structure', name + '.json')));
    const put = (file, value) => { const bytes = encoded(value); records.set(file, bytes); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    const record = vector('published'), review = vector('review');
    record.reviewRef = put('records/' + 'a'.repeat(64) + '.json', review);
    put('published/demo/2.3.4.json', record);
    const manager = { accountId: '202', accountType: 'User', publisherId: 'next' };
    put('plugin-bindings/demo.json', { schemaVersion: 1, pluginId: 'demo', owner: manager, effectiveRequestId: null, updatedAt: '2026-01-01T00:00:00Z' });
    const data = put('generated/generations/1/catalog.json', {}), revocations = { entries: [] };
    const snapshot = () => put('generated/current.json', { sequence: 2, descriptor: data, directory: data, catalog: data,
        revocations: put('revocations.json', revocations) });
    snapshot();
    const originalAssets = [{ id: 802, name: packageName(record), size: record.package.expectedSize, digest: 'sha256:' + record.package.sha256, state: 'uploaded' }];
    const assets = [...originalAssets, ...[['review.json', encoded(review)], ['community-signature.json', encoded(record.communitySignature)]]
        .map(([name, bytes], index) => ({ id: 803 + index, name, size: bytes.length, digest: 'sha256:' + hash(bytes), state: 'uploaded' }))];
    const formal = { id: 801, tag_name: formalTag(record), draft: false, name: 'Old name', body: 'Manual notes', target_commitish: current };
    const repo = { id: policy.repositoryId, full_name: policy.repository };
    const originalPr = { number: 3, state: 'open', merged: false, draft: false, changed_files: 1, user: { id: 101, type: 'User' },
        head: { sha: head, ref: 'community/request', repo }, base: { sha: source, ref: 'master', repo } };
    const inputFiles = [{ filename: 'submissions/101/demo/2.3.4.json', status: 'added' }];
    const made = makeReceipt({ requestId: 'd'.repeat(64), operation: 'FIRST_RELEASE', pr: originalPr,
        current: source, inputFiles, run: { id: 7, run_attempt: 1 }, writes: new Map(records), state: { raw: () => null }, appliedAt: '2026-01-01T00:00:00Z',
        releases: [{ id: 801, tag: formal.tag_name, targetCommit: current, originalAssets }] });
    made.value.schemaVersion = 2;
    made.value.files = made.value.files.map(({ blob, ...file }) => file);
    made.bytes = Buffer.from(JSON.stringify(made.value) + '\n');
    const parentRecords = new Map([[inputFiles[0].filename, encoded({ request: true })]]);
    for (const [file, bytes] of parentRecords) records.set(file, bytes);
    f.release.tag_name = `operation/${made.value.requestId}/7-1`;
    for (const [name, bytes] of [['publication.json', made.bytes], ['publication-attestation.json', Buffer.from('{}')]]) {
        const file = path.join(f.workspace, name); fs.writeFileSync(file, bytes); f.upload(501, file, name);
    }
    put(`generated/receipts/${made.value.requestId}.json`, { schemaVersion: 1, releaseId: '501', size: made.bytes.length, sha256: hash(made.bytes) });
    const generatedRecords = new Map(records);
    const pr = { ...originalPr, state: 'closed', merged: true, changed_files: made.value.files.length + 2,
        head: { ...originalPr.head, sha: generated }, merge_commit_sha: current };
    let patches = 0, tip = current;
    const blobId = bytes => crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    const call = (endpoint, options = {}) => {
        const route = endpoint.split('?')[0];
        if (route.startsWith(`${prefix}/git/trees/`)) {
            const commit = route.split('/').at(-1), tree = commit === current ? records : commit === generated ? generatedRecords : parentRecords;
            return { truncated: false, tree: [...tree].map(([path, bytes]) => ({ path, type: 'blob', mode: '100644', size: bytes.length, sha: blobId(bytes) })) };
        }
        if (route === `${prefix}/pulls/3`) return structuredClone(pr);
        if (route === `${prefix}/pulls/3/files`) return [[...inputFiles,
            ...made.value.files.map(file => ({ filename: file.path, status: 'added' })),
            { filename: `generated/receipts/${made.value.requestId}.json`, status: 'added' }]];
        if (route.endsWith('/check-runs')) return [{ total_count: 4, check_runs: policy.requiredContexts.map((name, i) => ({
            id: i + 1, name, app: policy.gateApp, head_sha: generated, external_id: '17:1:3', status: 'completed', conclusion: 'success' })) }];
        if (route.startsWith(`${prefix}/git/commits/`)) {
            const sha = route.split('/').at(-1);
            return { sha, parents: (sha === generated ? [head] : [source, generated]).map(sha => ({ sha })) };
        }
        if (route.startsWith(`${prefix}/git/blobs/`)) {
            const sha = route.split('/').at(-1), bytes = [...records.values(), ...generatedRecords.values(), ...parentRecords.values()].find(bytes => blobId(bytes) === sha);
            return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
        }
        if (route === `${prefix}/branches/master`) return { commit: { sha: tip } };
        if (route === `${prefix}/releases`) return [[structuredClone(formal), f.release,
            { id: 901, tag_name: 'archive/revoked-packages', draft: true, published_at: null }]];
        if (route === `${prefix}/releases/901/assets`) return [[{ ...originalAssets[0], id: 902, name: record.package.sha256 + '.jar' }]];
        if (route === `${prefix}/releases/801/assets`) return [assets];
        if (route.startsWith(`${prefix}/git/matching-refs/tags/`)) return [[{ ref: 'refs/tags/' + formal.tag_name, object: { type: 'commit', sha: current } }]];
        if (route === `${prefix}/releases/801`) {
            if (options.method === 'PATCH') { assert.deepEqual(Object.keys(options.body).sort(), ['body', 'name']); Object.assign(formal, options.body); patches++; throw new Error('RESPONSE_LOST'); }
            return structuredClone(formal);
        }
        return f.call(endpoint, options);
    };
    const options = { call, readGit: () => '', download: f.download, verify: () => ({ sourceRepositoryDigest: source }) };
    assert.equal((await finalizeReleases({ current }, sdk, { ...options, write: false })).applied, false);
    assert.equal(patches, 0);
    for (const state of ['ACTIVE', 'YANKED', 'REVOKED']) {
        revocations.entries = state === 'ACTIVE' ? [] : [{ pluginId: record.pluginId, action: state }]; snapshot();
        if (state === 'REVOKED') assets.shift();
        assert.equal((await finalizeReleases({ current }, sdk, options)).applied, true);
        assert.match(formal.body, new RegExp(`State: ${state}`));
        assert.ok(formal.body.startsWith('Manual notes')); assert.match(formal.body, /Current maintainer: next/);
        assert.equal(formal.tag_name, formalTag(record));
        if (state === 'REVOKED') assert(!assets.some(asset => asset.name === packageName(record)));
        else assert.deepEqual(assets.slice(0, 1), originalAssets);
        const before = patches;
        assert.equal((await finalizeReleases({ current }, sdk, { ...options, write: false })).applied, true); assert.equal(patches, before);
    }
    assets.unshift({ ...originalAssets[0], id: 900 });
    await assert.rejects(finalizeReleases({ current }, sdk, options), /PUBLICATION_ASSET_CHANGED/);
    assets[0] = originalAssets[0]; tip = 'e'.repeat(40);
    await assert.rejects(finalizeReleases({ current }, sdk, options), /PR_OR_BASE_CHANGED/);
});

test('正式发布状态保留原作者及人工说明，撤销优先于下架', () => {
    const record = { pluginId: 'demo', version: '2.3.4', package: { sha256: 'a'.repeat(64) }, communitySignature: { keyId: 'community' },
        owner: { accountType: 'User', accountId: '101', publisherId: 'original' }, sourceCommit: 'b'.repeat(40), reviewRef: { sha256: 'c'.repeat(64) } };
    const revocations = { entries: [{ pluginId: 'other', action: 'REVOKED' }, { pluginId: 'demo', action: 'YANKED' }] };
    assert.equal(releaseStatus(record, revocations), 'YANKED');
    revocations.entries.push({ packageSha256: record.package.sha256, action: 'REVOKED' });
    assert.equal(releaseStatus(record, revocations), 'REVOKED');
    assert.equal(releaseStatus(record, { entries: [] }), 'ACTIVE');
    const facts = { record, manager: { accountType: 'User', accountId: '202', publisherId: 'next' }, status: 'REVOKED', sequence: 2, review: { ownerLoginSnapshot: 'original' } };
    const body = releaseBody('Maintainer notes', facts);
    assert.ok(body.startsWith('Maintainer notes\n')); assert.match(body, /Original publisher: original/); assert.match(body, /Current maintainer: next/);
    assert.equal(releaseBody(body, facts), body);
    assert.throws(() => releaseBody(body + body, facts), /RELEASE_STATE_SECTION_INVALID/);
});

test('结果归档绑定受保护签发来源及原始字节，工具升级不破坏历史证明', async t => {
    const f = archiveFixture(t), current = 'b'.repeat(40), source = 'a'.repeat(40);
    const result = makeReceipt({ requestId: 'd'.repeat(64), operation: 'YANK', pr: { number: 3, state: 'open', merged: false, draft: false, head: { sha: 'c'.repeat(40) }, base: { sha: source } },
        current: source, run: { id: 7, run_attempt: 1 }, writes: new Map([['generated/current.json', encoded({ sequence: 1 })]]),
        state: { raw: () => null }, inputFiles: [], releases: [], appliedAt: '2026-01-01T00:00:00Z', reviewContext: { checked: { operation: 'YANK' } } });
    // 已发布的旧格式仍按原签名字节读取。
    result.value.schemaVersion = 2;
    result.value.files = result.value.files.map(({ blob, ...file }) => file);
    result.bytes = Buffer.from(JSON.stringify(result.value) + '\n');
    f.release.tag_name = `operation/${result.value.requestId}/7-1`;
    const file = path.join(f.workspace, 'publication.json'), bundle = path.join(f.workspace, 'publication-attestation.json');
    fs.writeFileSync(file, result.bytes); fs.writeFileSync(bundle, '{}');
    f.upload(501, file, 'publication.json'); f.upload(501, bundle, 'publication-attestation.json');
    const workflow = `https://github.com/${policy.repository}/${publicationPath}@refs/heads/master`;
    const certificate = { sourceRepositoryIdentifier: policy.repositoryId, sourceRepositoryOwnerIdentifier: policy.repositoryOwnerId,
        buildSignerURI: workflow, buildConfigURI: workflow, sourceRepositoryRef: 'refs/heads/master', runnerEnvironment: 'github-hosted',
        buildTrigger: 'workflow_dispatch', buildSignerDigest: source, sourceRepositoryDigest: source };
    const verified = [{ verificationResult: { signature: { certificate } } }];
    const readGit = args => { if (args[0] !== 'ls-tree') assert.deepEqual(args, ['merge-base', '--is-ancestor', source, current]); return ''; };
    let expectedPath = publicationPath;
    const verify = (file, bundle, current, readGit) => verifyPublicationProof(file, bundle, current, readGit, (command, args, options) => {
        assert.equal(command, 'gh'); assert.ok(args.includes('--deny-self-hosted-runners'));
        assert.ok(args.includes(`${policy.repository}/${expectedPath}`));
        assert.ok(Object.keys(options.env).every(key => !/TOKEN|SECRET|PRIVATE_KEY/iu.test(key)));
        return JSON.stringify(verified);
    });
    const pointer = { schemaVersion: 1, releaseId: '501', size: result.bytes.length, sha256: hash(result.bytes) };
    assert.deepEqual(await readReceipt({ workspace: f.workspace }, pointer, current, { ...f, readGit, verify }), result.value);
    certificate.buildTrigger = 'pull_request_target';
    assert.throws(() => publicationCertificate(verified, current, readGit), /ARCHIVE_ATTESTATION_SOURCE_INVALID/);
    certificate.buildTrigger = 'workflow_dispatch';
    await assert.rejects(readReceipt({ workspace: f.workspace }, { ...pointer, sha256: 'e'.repeat(64) }, current, { ...f, readGit, verify }), /APPLY_RECEIPT_CHANGED/);
    fs.writeFileSync(file, encoded({ ...result.value, authorization: 'SIGNED_OWNER' }));
    expectedPath = statusPath;
    assert.throws(() => verify(file, bundle, current, readGit), /ARCHIVE_ATTESTATION_SOURCE_INVALID/);
    certificate.buildSignerURI = certificate.buildConfigURI = `https://github.com/${policy.repository}/${statusPath}@refs/heads/master`;
    for (const trigger of ['workflow_run', 'workflow_dispatch']) {
        certificate.buildTrigger = trigger;
        assert.deepEqual(verify(file, bundle, current, readGit), certificate);
    }
    certificate.buildTrigger = 'pull_request_target';
    assert.throws(() => verify(file, bundle, current, readGit), /ARCHIVE_ATTESTATION_SOURCE_INVALID/);
    fs.writeFileSync(file, encoded({ ...result.value, operation: 'KEY_ROTATION', authorization: 'SIGNED_OWNER' }));
    certificate.buildTrigger = 'workflow_run';
    assert.deepEqual(verify(file, bundle, current, readGit), certificate);
    fs.writeFileSync(file, encoded({ ...result.value, operation: 'OWNERSHIP_TRANSFER', authorization: 'SIGNED_OWNER' }));
    assert.throws(() => verify(file, bundle, current, readGit), /APPLY_RECEIPT_INVALID/);
    assert.throws(() => makeReceipt({ ...result.value, current: source, pr: { number: 3, state: 'open', merged: false, draft: false, head: { sha: 'c'.repeat(40) }, base: { sha: source } }, run: { id: 7, run_attempt: 1 },
        writes: new Map([['tools/sdk-tools.jar', Buffer.from('replacement')]]), state: { raw: () => null } }), /APPLY_WRITE_FORBIDDEN/);
});
