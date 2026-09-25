import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission, withEmergencyState, withRepositoryFiles } from './local-sdk.mjs';
import { signingTool, signOperation } from '../submission-signing.mjs';
import { preparePublication, prepareResult } from '../community-publication.mjs';
import { restoreReview } from '../apply-context.mjs';
import { readReceiptFiles } from '../receipt-storage.mjs';
import { readRequestInfo } from '../community-comments.mjs';
import { encoded } from '../apply-generation.mjs';
import { hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { statusPath } from '../archive-proof.mjs';

test('两个旧基线请求顺序生成，真实 SDK 保留先前结果和原签名，相关状态冲突仍拒绝', async () => {
    const sdk = prepareSubmission(), sign = signingTool(sdk);
    const key = () => {
        const pair = crypto.generateKeyPairSync('ed25519');
        const privateBytes = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
        const privateFile = path.join(sdk.workspace, crypto.randomUUID() + '.pem');
        fs.writeFileSync(privateFile, privateBytes, { mode: 0o600 });
        return { privateBytes, privateFile, keyId: crypto.randomUUID(), algorithm: 'Ed25519',
            publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    };
    const publicKey = ({ keyId, algorithm, publicKeySpkiBase64 }) => ({ keyId, algorithm, publicKeySpkiBase64 });
    const community = key(), communityKey = { ...publicKey(community), state: 'ACTIVE', publisher: 'Community', trustLabel: 'Community', official: false };
    const source = 'a'.repeat(40), records = new Map(), requests = [];
    const repo = { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId, type: 'User' },
        default_branch: policy.defaultBranch, private: false, archived: false };
    for (const [number, account] of [[1, '101'], [2, '202']]) {
        const oldKey = key(), nextKey = key(), publisherId = `publisher${number}`, publisherPath = `publishers/${account}/${publisherId}.json`;
        const publisher = { schemaVersion: 1, publisherId, displayName: publisherId,
            githubAccount: { id: account, type: 'User', loginAtRegistration: publisherId }, signingKeys: [{ ...publicKey(oldKey), state: 'ACTIVE' }] };
        records.set(publisherPath, encoded(publisher));
        const request = signOperation(sdk, sign, 'ROTATION', { schemaVersion: 1, payload: { publisherId,
            githubAccount: { id: account, type: 'User' }, publisherRecordSha256: hash(records.get(publisherPath)),
            oldKeyId: oldKey.keyId, newKey: publicKey(nextKey), reasonCode: 'ROUTINE_ROTATION', explanation: 'Rotate verified keys' } }, { oldKey, newKey: nextKey });
        const file = `key-rotations/${account}/${publisherId}/${request.requestId}.json`, bytes = encoded(request);
        const blob = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
        const pr = { number, state: 'open', merged: false, draft: false, changed_files: 1, user: { id: account, type: 'User' },
            head: { sha: String(number + 1).repeat(40), ref: `community/request-${number}`, repo }, base: { sha: source, ref: 'master', repo } };
        requests.push({ pr, file, bytes, publisherPath, nextKey, files: [{ filename: file, status: 'added', sha: blob }] });
    }
    const revisions = new Map([[source, new Map(records)]]);
    for (const request of requests) revisions.set(request.pr.head.sha, new Map([...records, [request.file, request.bytes]]));
    let current = source;
    const call = withEmergencyState(withRepositoryFiles(endpoint => {
        if (endpoint === prefix) return repo;
        if (endpoint === `${prefix}/git/ref/heads/master`) return { object: { sha: current } };
        if (endpoint === `${prefix}/branches/master`) return { commit: { sha: current } };
        if (endpoint.includes('/collaborators?')) return [[{ id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' }]];
        if (endpoint.includes('/community-review-decision.yml/runs?')) return [{ total_count: 0, workflow_runs: [] }];
        if (endpoint === `${prefix}/environments/community-status`) return { can_admins_bypass: false,
            deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [] };
        if (endpoint.includes('/deployment-branch-policies?')) return [{ total_count: 1, branch_policies: [{ name: 'master', type: 'branch' }] }];
        for (const request of requests) {
            if (endpoint === `${prefix}/pulls/${request.pr.number}`) return structuredClone(request.pr);
            if (endpoint.startsWith(`${prefix}/pulls/${request.pr.number}/files?`)) return [request.files];
            if (endpoint.startsWith(`${prefix}/pulls/${request.pr.number}/reviews?`)) return [[]];
        }
        assert.fail(endpoint);
    }, policy.repository, revisions));
    let firstPublisher;
    for (const request of requests) {
        const jobSdk = prepareSubmission();
        const context = { current, automatic: true, run: { id: 50 + request.pr.number, run_attempt: 1,
            event: 'workflow_dispatch', path: statusPath, sourceSha: source, created_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') } };
        const inputs = { prNumber: request.pr.number, expectedHeadSha: request.pr.head.sha, reason: 'Signed request',
            recoveryApproved: false, organizationRepresentations: '' };
        if (firstPublisher) {
            const baseline = revisions.get(current), original = baseline.get(request.publisherPath);
            baseline.set(request.publisherPath, encoded({ ...JSON.parse(original), displayName: 'Changed registration' }));
            await assert.rejects(preparePublication(context, inputs, jobSdk, { call, checkCall: call }), /PUBLISHER_CHANGED/);
            baseline.set(request.publisherPath, original);
        }
        const prepared = await preparePublication(context, inputs, jobSdk, { call, checkCall: call });
        assert.equal(prepared.pending, undefined);
        assert.equal(prepared.version.checked.pr.head, request.pr.head.sha);
        assert.equal(prepared.version.checked.pr.base, current);
        assert.equal(prepared.selected.pr.base.sha, current);
        if (firstPublisher) assert.deepEqual(prepared.state.raw(requests[0].publisherPath), firstPublisher);
        const result = await prepareResult(context, inputs, jobSdk, prepared,
            { privateBytes: community.privateBytes, communityKey }, { call, checkCall: call });
        assert.equal(result.value.headSha, request.pr.head.sha);
        assert.equal(result.value.sourceSha, source);
        assert.equal(result.value.baseSha, current);
        const receipt = readReceiptFiles(JSON.parse(fs.readFileSync(result.file, 'utf8')), path.join(jobSdk.workspace, 'publication-files'));
        const restored = restoreReview(jobSdk, prepared.state, receipt);
        const info = readRequestInfo(jobSdk, restored.checked, request.pr, call);
        for (const body of Object.values(info)) {
            assert(body.includes(`/blob/${request.pr.head.sha}/${request.file}`));
            assert(body.includes(hash(request.bytes)));
        }
        const audit = JSON.parse(Buffer.from(result.value.files.find(file => file.path.startsWith('audits/')).bytes, 'base64'));
        assert.equal(audit.authorization, 'SIGNED_OWNER');
        assert.equal(audit.prEvidence[0].headSha, request.pr.head.sha);
        assert.equal(audit.prEvidence[0].baseSha, current);
        records.set(request.file, request.bytes);
        for (const file of result.value.files) records.set(file.path, Buffer.from(file.bytes, 'base64'));
        assert.equal(JSON.parse(records.get('generated/current.json')).sequence, request.pr.number);
        const keys = JSON.parse(records.get(request.publisherPath)).signingKeys;
        assert.equal(keys.find(key => key.keyId === request.nextKey.keyId)?.state, 'ACTIVE');
        assert.equal(keys.filter(key => key.keyId !== request.nextKey.keyId).every(key => key.state === 'RETIRED'), true);
        firstPublisher = records.get(requests[0].publisherPath);
        current = String(request.pr.number + 5).repeat(40);
        revisions.set(current, new Map(records));
    }
    assert.deepEqual(records.get(requests[0].file), requests[0].bytes);
    assert.deepEqual(records.get(requests[1].file), requests[1].bytes);
    community.privateBytes.fill(0);
});
