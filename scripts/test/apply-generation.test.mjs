import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission } from './local-sdk.mjs';
import { applySdk } from '../apply-sdk.mjs';
import { generateState, encoded, packageUrl } from '../apply-generation.mjs';
import { releaseStatus } from '../publication-releases.mjs';
import { hash, root } from '../sdk.mjs';
import { prepareResult } from '../community-publication.mjs';
import { policy } from '../github.mjs';

test('真实 SDK 签发并整代验签，转移保留原包归属，撤销历史密钥生成独立限制', async () => {
    const sdk = prepareSubmission();
    const records = new Map();
    const state = { tree: records, raw: file => records.get(file) ?? null };
    const vector = name => JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/structure', name + '.json')));
    const pair = crypto.generateKeyPairSync('ed25519');
    const privateBytes = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const communityKey = { keyId: crypto.randomUUID(), algorithm: 'Ed25519', publicKeySpkiBase64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        state: 'ACTIVE', publisher: 'Community', trustLabel: 'Community', official: false };
    const original = vector('publisher');
    const record = vector('published');
    record.communitySignature.keyId = communityKey.keyId;
    original.signingKeys[0].keyId = record.package.signature.keyId;
    const put = value => { const bytes = encoded(value), file = `records/${hash(bytes)}.json`; records.set(file, bytes); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    record.historicalPublisherRef = put(original);
    record.reviewRef = put(vector('review'));
    record.submissionRef = put(JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json'))));
    records.set('published/demo/2.3.4.json', encoded(record));
    records.set('publishers/101/example.json', encoded(original));
    records.set('plugin-bindings/demo.json', encoded({ schemaVersion: 1, pluginId: 'demo', owner: record.owner,
        effectiveRequestId: null, updatedAt: '2026-01-01T00:00:00Z' }));
    const generation = (day, nextUpdate = '2026-02-01T00:00:00Z') => {
        const adapter = applySdk(sdk), writes = new Map();
        const decision = adapter.archive({ approved: true, day });
        const result = generateState({ sdk, adapter, state, writes, communityKey, privateBytes,
            appliedAt: `2026-01-0${day}T00:00:00Z`, nextUpdate, decision });
        return { adapter, writes, result };
    };
    const first = generation(2);
    const catalog = JSON.parse(first.writes.get('generated/catalog.json'));
    assert.equal(first.result.sequence, 1);
    assert.equal(catalog.entries[0].packages[0].packageUrl, packageUrl(record));
    first.writes.forEach((bytes, file) => records.set(file, bytes));
    const immutable = new Map([...records].filter(([file]) => file.startsWith('generated/generations/1/')));
    const target = { accountId: '202', accountType: 'User', publisherId: 'next' };
    records.set('plugin-bindings/demo.json', encoded({ schemaVersion: 1, pluginId: 'demo', owner: target,
        effectiveRequestId: 'a'.repeat(64), updatedAt: '2026-01-03T00:00:00Z' }));
    const moved = generation(3);
    const movedCatalog = JSON.parse(moved.writes.get('generated/catalog.json'));
    assert.deepEqual(movedCatalog.entries[0].owner, target);
    assert.deepEqual(movedCatalog.entries[0].packages[0].historicalOwner, record.owner);
    assert.equal(movedCatalog.entries[0].packages[0].packageUrl, packageUrl(record));
    moved.writes.forEach((bytes, file) => records.set(file, bytes));
    const active = { ...original.signingKeys[0], keyId: crypto.randomUUID(), publicKeySpkiBase64: communityKey.publicKeySpkiBase64, state: 'ACTIVE' };
    original.signingKeys[0].state = 'REVOKED'; original.signingKeys.push(active);
    records.set('publishers/101/example.json', encoded(original));
    const revoked = generation(4);
    const document = JSON.parse(revoked.writes.get('revocations.json'));
    assert.equal(releaseStatus(record, document), 'REVOKED');
    assert.equal(JSON.parse(revoked.writes.get('revocations/restrictions.json'))[0].communityIndependent, true);
    for (const [file, bytes] of immutable) assert.deepEqual(records.get(file), bytes);
    const adapter = revoked.adapter, current = revoked.result.current;
    const request = { command: 'verify-generation', communityKey, repositoryId: 'pixivdownloader-community', directory: current.directory,
        directorySignature: current.directorySignature, rootUrl: 'https://example.org/directory.json',
        shards: [...adapter.records.values()].filter(ref => ref.path.startsWith('generated/generations/3/shards/')),
        catalog: current.catalog, catalogSignature: JSON.parse(revoked.writes.get('generated/catalog.json.sig')),
        revocations: current.revocations, revocationSignature: JSON.parse(revoked.writes.get('revocations.json.sig')) };
    assert.throws(() => adapter.invoke({ ...request, shards: [] }), /REVIEW_MISMATCH/);
    assert.throws(() => adapter.invoke({ ...request, directorySignature: request.catalogSignature }), /INVALID_SIGNATURE/);
    assert.throws(() => adapter.invoke({ ...request, revocationSignature: request.catalogSignature }), /GENERATION_SIGNATURE_INVALID/);
    assert.throws(() => generateState({ sdk, adapter, state, writes: new Map(), communityKey: { ...communityKey, keyId: 'changed' }, privateBytes,
        appliedAt: '2026-01-05T00:00:00Z', nextUpdate: '2026-02-01T00:00:00Z' }), /COMMUNITY_ROOT_CHANGED/);
    revoked.writes.forEach((bytes, file) => records.set(file, bytes));
    const refreshed = generation(5, '2026-02-04T00:00:00Z');
    assert.equal(refreshed.result.sequence, revoked.result.sequence + 1);
    const renewed = JSON.parse(refreshed.writes.get('revocations.json'));
    assert.equal(renewed.nextUpdate, '2026-02-04T00:00:00Z'); assert.deepEqual(renewed.entries, document.entries);
    assert.equal(releaseStatus(record, renewed), 'REVOKED');
    refreshed.writes.forEach((bytes, file) => records.set(file, bytes));
    for (const [file, bytes] of immutable) assert.deepEqual(records.get(file), bytes);
    const reviewer = { id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' };
    const context = { current: 'a'.repeat(40), run: { id: 17, run_attempt: 1, event: 'workflow_dispatch', triggering_actor: reviewer } };
    const call = endpoint => {
        if (endpoint.includes('/collaborators?')) return [[reviewer]];
        if (endpoint.endsWith('/environments/release')) return { id: 5, can_admins_bypass: false,
            deployment_branch_policy: { custom_branch_policies: true },
            protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer }] }] };
        if (endpoint.includes('/deployment-branch-policies?')) return [{ branch_policies: [{ name: 'master', type: 'branch' }], total_count: 1 }];
        if (endpoint.endsWith('/actions/runs/17/approvals')) return [{ state: 'approved', user: reviewer, environments: [{ id: 5, name: 'release' }] }];
        throw new Error('Unexpected request ' + endpoint);
    };
    const pr = { number: 9, state: 'open', merged: false, draft: false, user: { id: 41898282, type: 'Bot' },
        head: { sha: 'b'.repeat(40), repo: { id: policy.repositoryId } }, base: { sha: context.current } };
    const prepared = await prepareResult(context, { reason: 'Renew unchanged state' }, sdk, { selected: { pr }, state,
        requestId: 'c'.repeat(64), version: { checked: { operation: 'RENEWAL', requestSha256: 'c'.repeat(64) } },
        appliedAt: '2026-01-06T00:00:00Z', inputFiles: [{ filename: 'renewals/revocations.json', status: 'added' }] },
    { communityKey, privateBytes }, { call });
    assert.equal(prepared.value.operation, 'RENEWAL');
    assert.deepEqual(prepared.value.releases, []);
    assert.ok(prepared.value.files.every(file => !/^(?:published|publishers|plugin-bindings|audits)\//u.test(file.path)));
    const signed = JSON.parse(Buffer.from(prepared.value.files.find(file => file.path === 'revocations.json').bytes, 'base64'));
    assert.deepEqual(signed.entries, renewed.entries);
    assert.equal(signed.nextUpdate, '2026-02-05T00:00:00Z');
    privateBytes.fill(0);
});
