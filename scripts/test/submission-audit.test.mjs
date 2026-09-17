import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { prepareSubmission } from './local-sdk.mjs';
import { signOperation } from '../submission-signing.mjs';
import { stateReader, bytesReference } from '../submission-github.mjs';
import { root } from '../sdk.mjs';
import { policy } from '../github.mjs';

test('审计原始字节推导当前 YANK 决定，旧引用与 REVOKE 后恢复均拒绝', () => {
    const sdk = prepareSubmission();
    const files = new Map();
    const blobs = new Map();
    const put = (file, value) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
        files.set(file, { path: file, mode: '100644', type: 'blob', size: bytes.length, sha });
        blobs.set(sha, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
        return bytesReference(file, bytes);
    };
    const call = endpoint => endpoint.includes('/git/trees/') ? { tree: [...files.values()] }
        : blobs.get(endpoint.split('/').at(-1));
    const readState = request => stateReader(sdk, 'a'.repeat(40), call).currentStatus('demo', '2.3.4', 'a'.repeat(64), request);
    const request = (action, decision, explanation = action) => signOperation(sdk, null, 'STATUS_REQUEST', {
        schemaVersion: 1, payload: { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
            requester: { id: '101', type: 'User' }, pluginBindingSha256: 'b'.repeat(64), pluginId: 'demo', version: '2.3.4',
            packageSha256: 'a'.repeat(64), action, reasonCode: action === 'REVOKE' ? 'MALICIOUS_CODE' : 'OTHER', explanation,
            ...(action === 'UNYANK' ? { yankedDecisionSha256: decision } : {}) },
    }, {});
    const applied = (value, sequence) => {
        const audit = JSON.parse(fs.readFileSync(root + 'schemas/community/v1/vectors/structure/audit.json', 'utf8'));
        Object.assign(audit, { requestId: value.requestId, action: value.payload.action, revocationSequence: sequence,
            requestRef: put(`history/${value.requestId}/request.json`, value),
            beforeRef: put(`history/${sequence}/before.json`, { sequence: sequence - 1 }),
            afterRef: put(`history/${sequence}/after.json`, { sequence }),
            decisionRef: put(`reviews/${sequence}/decision.json`, { decision: sequence }) });
        audit.prEvidence[0].mergeSha = 'd'.repeat(40);
        audit.prEvidence[0].githubRepositoryId = policy.repositoryId;
        put(`audits/${value.requestId}.json`, audit);
        return audit;
    };
    assert.equal(readState().state, 'ACTIVE');
    const yank = request('YANK');
    const first = applied(yank, 2);
    assert.equal(readState().decisionSha256, first.decisionRef.sha256);
    assert.throws(() => readState(request('YANK', undefined, 'again')), /INVALID_STATE_TRANSITION/u);
    assert.throws(() => readState(request('UNYANK', 'e'.repeat(64))), /BASELINE_CHANGED/u);
    applied(request('UNYANK', first.decisionRef.sha256), 5);
    assert.equal(readState().state, 'ACTIVE');
    const second = applied(request('YANK', undefined, 'new defect'), 8);
    assert.equal(readState().decisionSha256, second.decisionRef.sha256);
    assert.throws(() => readState(request('UNYANK', first.decisionRef.sha256)), /BASELINE_CHANGED/u);
    applied(request('REVOKE'), 9);
    assert.equal(readState().state, 'REVOKED');
    assert.throws(() => readState(request('UNYANK', second.decisionRef.sha256)), /INVALID_STATE_TRANSITION/u);
    put(first.decisionRef.path, { changed: true });
    assert.throws(() => readState(), /AUDIT_REFERENCE_MISMATCH/u);
});
