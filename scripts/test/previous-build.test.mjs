import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previousBuild, prefetchPrevious } from '../submission-build.mjs';
import { hash } from '../sdk.mjs';
import { prefix } from '../github.mjs';
import { revokedPackageTag } from '../revoked-packages.mjs';

test('撤销基线从可信作业交接原包，构建只读复核字节，正常版本仍用公开下载', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-build-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.from('reviewed package'), commit = 'a'.repeat(40);
    const record = { pluginId: 'demo', version: '2.3.4', sourceCommit: commit, owner: { publisherId: 'author' },
        reviewRef: { path: 'review' }, package: { url: 'https://example.org/package.zip', expectedSize: bytes.length, sha256: hash(bytes) } };
    const checked = { pluginId: 'demo', submission: { source: { previousReviewedCommit: commit } } };
    const sources = path.join(directory, 'source'); fs.mkdirSync(sources); fs.writeFileSync(path.join(sources, 'code'), 'source');
    const evidence = { review: { source: { commit }, packageSha256: hash(bytes), pluginId: 'demo', assuranceLevel: 'SOURCE_REVIEWED',
        rebuildProofRef: { path: 'proof' }, buildProfile: { projectDir: '.' } }, proof: { dependencyLockRef: { path: 'lock' } },
        lock: { sourceCommit: commit, packageSha256: hash(bytes), compiledClasses: [] } };
    for (const action of ['ACTIVE', 'YANKED', 'REVOKED']) {
        const workspace = path.join(directory, action); fs.mkdirSync(workspace);
        const sdk = { workspace, invoke: () => ({ maxArchiveBytes: 1000 }), document: (_, bytes) => ({ value: JSON.parse(bytes) }) };
        const state = { published: () => [{ value: record }], reference: ref => Buffer.from(JSON.stringify(evidence[ref.path])),
            raw: () => Buffer.from(JSON.stringify({ entries: action === 'ACTIVE' ? [] : [{ pluginId: 'demo', action }] })) };
        let publicDownloads = 0, archiveDownloads = 0;
        const call = endpoint => {
            assert.equal(action, 'REVOKED');
            if (endpoint === prefix + '/releases?per_page=100') return [[{ id: 1, tag_name: revokedPackageTag, draft: true, published_at: null }]];
            assert.equal(endpoint, prefix + '/releases/1/assets?per_page=100');
            return [[{ id: 2, name: hash(bytes) + '.jar', size: bytes.length, digest: 'sha256:' + hash(bytes), state: 'uploaded' }]];
        };
        const handoff = path.join(workspace, 'handoff');
        const available = await prefetchPrevious(sdk, checked, state, handoff, { call, fetch: (endpoint, file, limit, expected) => {
            assert.equal(endpoint, prefix + '/releases/assets/2'); assert.equal(expected.sha256, hash(bytes)); assert(bytes.length <= limit);
            archiveDownloads++; fs.writeFileSync(file, bytes, { flag: 'wx' });
        } });
        assert.equal(available, action === 'REVOKED');
        const options = { archivedFile: available ? path.join(handoff, 'package') : '', source: async () => ({ sourceRoot: sources }) };
        const fetch = async (url, file, limit, expected) => {
            assert.equal(url, record.package.url); assert.equal(expected.sha256, hash(bytes)); assert(bytes.length <= limit);
            publicDownloads++; fs.writeFileSync(file, bytes, { flag: 'wx' });
        };
        const result = await previousBuild(sdk, checked, state, fetch, options);
        assert.deepEqual(fs.readFileSync(result.scan.artifact), bytes);
        assert.equal(result.scan.sha256, hash(bytes)); assert.equal(result.sourceFiles.length, 1);
        assert.equal(publicDownloads, available ? 0 : 1); assert.equal(archiveDownloads, available ? 1 : 0);
        if (available) {
            fs.writeFileSync(options.archivedFile, 'tampered package');
            await assert.rejects(previousBuild(sdk, checked, state, fetch, options), /PREVIOUS_PACKAGE_CHANGED/);
            assert.equal(publicDownloads, 0);
        }
    }
});
