import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveRevokedPackage, archivedPackage, revokedPackageTag } from '../revoked-packages.mjs';
import { hash } from '../sdk.mjs';
import { prefix } from '../github.mjs';

test('撤销包完成归档回读后才删除公开附件，中断重试复用同一归档', async t => {
    for (const failure of [false, true]) {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'revoked-package-'));
        t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
        const bytes = Buffer.from('original signed package'), current = 'a'.repeat(40);
        const record = { owner: { publisherId: 'author' }, pluginId: 'demo', version: '2.3.4', package: { expectedSize: bytes.length, sha256: hash(bytes) } };
        const original = { id: 10, name: 'plugin.jar', state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) };
        const release = { id: 1, tag_name: 'author/demo-v2.3.4', draft: false, immutable: false }, packages = [original], archived = [];
        let archive, uploads = 0, deletes = 0, interrupted = failure, readback = false;
        const call = (endpoint, options = {}) => {
            if (endpoint === prefix + '/branches/master') return { commit: { sha: current } };
            if (endpoint === prefix + '/releases/1') return structuredClone(release);
            if (endpoint === prefix + '/releases?per_page=100') return [[release, ...(archive ? [archive] : [])]];
            if (endpoint === prefix + '/releases' && options.method === 'POST') {
                assert.equal(archive, undefined); archive = { id: 2, published_at: null, ...options.body }; return archive;
            }
            if (endpoint === prefix + '/releases/1/assets?per_page=100') return [structuredClone(packages)];
            if (endpoint === prefix + '/releases/2/assets?per_page=100') return [structuredClone(archived)];
            if (endpoint === prefix + '/releases/assets/10' && options.method === 'DELETE') {
                assert.equal(readback, true); deletes++; packages.length = 0;
                throw new Error('DELETE_RESPONSE_LOST');
            }
            assert.fail(endpoint);
        };
        const transport = { call, download: (endpoint, file, maximum, expected) => {
            assert.equal(expected.sha256, hash(bytes)); assert(bytes.length <= maximum);
            if (endpoint.endsWith('/20')) { if (interrupted) throw new Error('ARCHIVE_READBACK_FAILED'); readback = true; }
            fs.writeFileSync(file, bytes, { flag: 'wx' });
        }, upload: (id, file, name) => {
            assert.equal(id, 2); assert.equal(name, hash(bytes) + '.jar'); assert.deepEqual(fs.readFileSync(file), bytes);
            uploads++; const asset = { ...original, id: 20, name }; archived.push(asset); return asset;
        } };
        if (failure) {
            await assert.rejects(archiveRevokedPackage(current, record, 1, original, workspace, transport), /ARCHIVE_READBACK_FAILED/);
            assert.equal(deletes, 0); assert.equal(packages.length, 1); interrupted = false;
        }
        await archiveRevokedPackage(current, record, 1, original, workspace, transport);
        assert.equal(uploads, 1); assert.equal(deletes, 1); assert.equal(packages.length, 0);
        assert.equal(archivedPackage(record, call).release.tag_name, revokedPackageTag);
        archive.draft = false;
        assert.throws(() => archivedPackage(record, call), /REVOKED_ARCHIVE_CONFLICT/);
    }
});
