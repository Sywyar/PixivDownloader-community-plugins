import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission } from './local-sdk.mjs';
import { signingTool, signOperation } from '../submission-signing.mjs';
import { applySdk } from '../apply-sdk.mjs';
import { applyOperation } from '../apply-operations.mjs';
import { hash, evaluate, evidence } from '../sdk.mjs';
import { signedStatusAuthority } from '../status-authorization.mjs';
import { API_BYTES } from '../github.mjs';

test('真实 SDK 执行换钥、版本处置及转移，保留证据并拒绝缺少批准和重复覆盖', () => {
    const sdk = prepareSubmission(), sign = signingTool(sdk);
    const records = new Map();
    const encode = value => Buffer.from(JSON.stringify(value) + '\n');
    const store = (file, value) => records.set(file, Buffer.isBuffer(value) ? value : encode(value));
    let currentState = { pluginId: 'demo', version: '2.3.4', packageSha256: 'a'.repeat(64), state: 'ACTIVE', decisionSha256: null };
    const state = { tree: records, raw: file => records.get(file) ?? null,
        read(file, kind) { const bytes = records.get(file); return bytes ? { ...sdk.document(kind, bytes, file), bytes, path: file } : null; },
        reference(ref) { const bytes = records.get(ref.path); assert.equal(bytes?.length, ref.size); assert.equal(hash(bytes), ref.sha256); return bytes; },
        currentStatus: () => currentState };
    const key = () => {
        const pair = crypto.generateKeyPairSync('ed25519');
        const privateFile = path.join(sdk.workspace, crypto.randomUUID() + '.pem');
        fs.writeFileSync(privateFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
        return { keyId: crypto.randomUUID(), algorithm: 'Ed25519', publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateFile };
    };
    const first = key(), next = key(), target = key();
    const publicKey = ({ privateFile: _private, ...key }) => key;
    const owner = { accountId: '101', accountType: 'User', publisherId: 'original' };
    const to = { accountId: '202', accountType: 'User', publisherId: 'target' };
    const publisherPath = 'publishers/101/original.json';
    store(publisherPath, { schemaVersion: 1, publisherId: 'original', displayName: 'Original',
        githubAccount: { id: '101', type: 'User', loginAtRegistration: 'original' }, signingKeys: [{ ...publicKey(first), state: 'ACTIVE' }] });
    assert.throws(() => sdk.document('PUBLISHER', { ...JSON.parse(records.get(publisherPath)), displayName: 'x'.repeat(16385) }, publisherPath), /LIMIT_EXCEEDED/);
    store('plugin-bindings/demo.json', { schemaVersion: 1, pluginId: 'demo', owner, effectiveRequestId: null, updatedAt: '2026-01-01T00:00:00Z' });
    store('revocations.json', { schemaVersion: 1, repositoryId: 'pixivdownloader-community', sequence: 1,
        generatedTime: '2026-01-01T00:00:00Z', nextUpdate: '2026-02-01T00:00:00Z', entries: [] });
    store('revocations/restrictions.json', []);
    const pr = (author, number) => ({ githubRepositoryId: '300', number, authorAccountId: author,
        headRepositoryId: '400', headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), mergeSha: 'd'.repeat(40) });
    const execute = (operation, request, file, { recovery = false, author = '101', approvals = [], signed = false, decisionBytes } = {}) => {
        const adapter = applySdk(sdk);
        store(file, request);
        const decision = adapter.archive(decisionBytes ?? { requestId: request.requestId, approved: true, recovery });
        let authority = { proposalPr: { ...pr(author, 1), mergeSha: null }, actualAuthor: { id: author, type: 'User' }, representations: [],
            approval: { requestId: request.requestId, headSha: 'b'.repeat(40), reviewerAccountIds: ['999'],
                recoveryApproved: recovery, evidence: adapter.evidence(decision) }, authorizedReviewers: ['999'] };
        if (signed) authority = signedStatusAuthority(request, authority.proposalPr, adapter, { sourceCommit: 'c'.repeat(40), runId: '51', runAttempt: 1 }).authority;
        for (const approval of approvals) adapter.archive(records.get(approval.reference.path), approval.reference.path);
        return applyOperation({ sdk, adapter, state, checked: { operation, requestPath: file, requestSha256: hash(records.get(file)), owner, targetLogin: 'target' },
            authority, approvals, appliedAt: '2026-01-02T00:00:00Z', nextUpdate: '2026-02-02T00:00:00Z', recoveryEvidence: recovery ? [decision] : [] });
    };
    const rotation = signOperation(sdk, sign, 'ROTATION', { schemaVersion: 1, payload: { publisherId: owner.publisherId,
        githubAccount: { id: owner.accountId, type: 'User' }, publisherRecordSha256: hash(records.get(publisherPath)),
        oldKeyId: first.keyId, newKey: publicKey(next), reasonCode: 'KEY_LOST', explanation: 'Replace lost key' } }, { newKey: next });
    const rotationFile = `key-rotations/101/original/${rotation.requestId}.json`;
    assert.throws(() => execute('KEY_ROTATION', rotation, rotationFile), /RECOVERY_REVIEW_REQUIRED/);
    const decisionBytes = encode({ requestId: rotation.requestId, approved: true, recovery: true,
        check_runs: Array.from({ length: 256 }, (_, index) => ({ id: index + 1, name: 'community/validation',
            head_sha: 'b'.repeat(40), conclusion: 'success', app: { id: 999 }, output: { summary: 'Verified request evidence. '.repeat(16) } })) });
    assert.ok(decisionBytes.length > 16384);
    const rotated = execute('KEY_ROTATION', rotation, rotationFile, { recovery: true, decisionBytes });
    assert.equal(rotated.audit.action, 'PUBLISHER_KEY_ROTATION');
    assert.equal(rotated.audit.decisionRef.sha256, hash(decisionBytes));
    assert.equal(rotated.audit.decisionRef.size, decisionBytes.length);
    assert.deepEqual(rotated.writes.get(rotated.audit.decisionRef.path), decisionBytes);
    // 原始证据仍在输入预算内，Base64 扩张后的封装必须受输出总预算约束。
    const oversized = Buffer.alloc(API_BYTES * 3 / 4, 0x20);
    decisionBytes.copy(oversized);
    assert.throws(() => execute('KEY_ROTATION', rotation, rotationFile, { recovery: true, decisionBytes: oversized }), /APPLY_OUTPUT_BUDGET/);
    rotated.writes.forEach((bytes, file) => store(file, bytes));
    const updated = state.read(publisherPath, 'PUBLISHER').value;
    assert.equal(updated.signingKeys.find(key => key.keyId === first.keyId).state, 'RETIRED');
    assert.equal(updated.signingKeys.find(key => key.keyId === next.keyId).state, 'ACTIVE');
    assert.equal(execute('KEY_ROTATION', rotation, rotationFile).writes.size, 0);
    for (const action of ['YANK', 'UNYANK', 'REVOKE']) {
        const payload = { owner, requester: { id: '101', type: 'User' }, pluginBindingSha256: hash(records.get('plugin-bindings/demo.json')),
            pluginId: 'demo', version: currentState.version, packageSha256: currentState.packageSha256, action,
            reasonCode: action === 'YANK' ? 'FUNCTIONAL_DEFECT' : action === 'UNYANK' ? 'ISSUE_RESOLVED' : 'CRITICAL_VULNERABILITY', explanation: 'Version management',
            ...(action === 'UNYANK' ? { yankedDecisionSha256: currentState.decisionSha256 } : {}) };
        const request = signOperation(sdk, sign, 'STATUS_REQUEST', { schemaVersion: 1, payload }, { activeKey: next });
        const file = `version-status-requests/101/demo/2.3.4/${request.requestId}.json`;
        const result = execute(action, request, file, { signed: true });
        assert.equal(result.audit.authorization, 'SIGNED_OWNER');
        assert.equal(result.audit.result, 'PREPARED');
        assert.deepEqual(result.audit.reviewerAccountIds, []);
        const snapshot = { repositoryId: 'community-catalog', pr: result.audit.prEvidence[0], version: null,
            inputSha256: hash(records.get(file)), bindingSha256: payload.pluginBindingSha256, policySha256: 'f'.repeat(64), state: 'OPEN', draft: false };
        const ref = evidence(sdk.workspace, result.audit);
        const admission = evaluate(sdk, { before: snapshot, after: snapshot, validation: { conclusion: 'SUCCESS', publisherId: '999',
            headSha: snapshot.pr.headSha, baseSha: snapshot.pr.baseSha, inputSha256: snapshot.inputSha256,
            bindingSha256: snapshot.bindingSha256, policySha256: snapshot.policySha256 }, publisherId: '999',
            policy: { reviewerAccountIds: ['999'], dismissalAccountIds: ['999'], decisionWorkflowPath: '.github/workflows/community-review-decision.yml', decisionWorkflowShas: ['c'.repeat(40)] },
            reviews: [], decisions: [], report: null, declaration: { present: false, signals: [] }, statusAudit: ref, evidence: [ref] });
        assert.equal(admission.authorization, 'SIGNED_OWNER');
        assert.equal(admission.flow, 'READY');
        assert.equal(admission.human.status, 'PENDING');
        result.writes.forEach((bytes, file) => store(file, bytes));
        currentState = { ...currentState, state: action === 'YANK' ? 'YANKED' : action === 'REVOKE' ? 'REVOKED' : 'ACTIVE',
            decisionSha256: action === 'UNYANK' ? null : result.audit.decisionRef.sha256 };
        const revocations = JSON.parse(records.get('revocations.json'));
        assert.equal(revocations.entries.length, action === 'UNYANK' ? 0 : 1);
        assert.equal(revocations.sequence, result.audit.revocationSequence);
        assert.equal(execute(action, request, file).writes.size, 0);
    }
    const transfer = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload: { pluginId: 'demo',
        pluginBindingSha256: hash(records.get('plugin-bindings/demo.json')), from: owner, to,
        targetPublisherRecordSha256: null, targetKey: publicKey(target), targetPublisherDisplayName: 'Target', mode: 'REGULAR', explanation: 'Transfer stewardship' } }, { targetKey: target });
    const transferRoot = `ownership-transfers/demo/${transfer.requestId}`;
    const approvals = ['FROM', 'TO'].map((role, index) => {
        const author = index === 0 ? '101' : '202';
        const file = `${transferRoot}/approvals/${role.toLowerCase()}/${author}.json`;
        const bytes = encode({ schemaVersion: 1, requestId: transfer.requestId, role }); store(file, bytes);
        return { reference: { path: file, size: bytes.length, sha256: hash(bytes) }, pr: pr(author, index + 2), author: { id: author, type: 'User' } };
    });
    assert.throws(() => execute('OWNERSHIP_TRANSFER', transfer, `${transferRoot}/proposal.json`, { approvals: approvals.slice(1) }), /APPROVAL_REQUIRED/);
    const transferred = execute('OWNERSHIP_TRANSFER', transfer, `${transferRoot}/proposal.json`, { approvals });
    transferred.writes.forEach((bytes, file) => store(file, bytes));
    assert.deepEqual(state.read('plugin-bindings/demo.json', 'BINDING').value.owner, to);
    assert.equal(state.read('publishers/202/target.json', 'PUBLISHER').value.signingKeys[0].keyId, target.keyId);
    assert.equal(execute('OWNERSHIP_TRANSFER', transfer, `${transferRoot}/proposal.json`).writes.size, 0);
    const controlBytes = encode({ proof: 'Native source account recovery evidence' });
    const controlFile = `ownership-transfer-evidence/demo/${hash(controlBytes)}.bin`;
    store(controlFile, controlBytes);
    const recovery = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload: { pluginId: 'demo',
        pluginBindingSha256: hash(records.get('plugin-bindings/demo.json')), from: to, to: owner,
        targetPublisherRecordSha256: hash(records.get(publisherPath)), targetKey: { keyId: next.keyId }, mode: 'RECOVERY',
        explanation: 'Recover stewardship after account loss', recoveryEvidence: [{ path: controlFile, size: controlBytes.length, sha256: hash(controlBytes) }] } }, { targetKey: next });
    const recoveryRoot = `ownership-transfers/demo/${recovery.requestId}`;
    const approvalFile = `${recoveryRoot}/approvals/to/101.json`;
    const approvalBytes = encode({ schemaVersion: 1, requestId: recovery.requestId, role: 'TO' }); store(approvalFile, approvalBytes);
    const recoveryApprovals = [{ reference: { path: approvalFile, size: approvalBytes.length, sha256: hash(approvalBytes) }, pr: pr('101', 4), author: { id: '101', type: 'User' } }];
    assert.throws(() => execute('OWNERSHIP_TRANSFER', recovery, `${recoveryRoot}/proposal.json`, { approvals: recoveryApprovals }), /RECOVERY_REVIEW_REQUIRED/);
    const restored = execute('OWNERSHIP_TRANSFER', recovery, `${recoveryRoot}/proposal.json`, { approvals: recoveryApprovals, recovery: true });
    restored.writes.forEach((bytes, file) => store(file, bytes));
    assert.deepEqual(state.read('plugin-bindings/demo.json', 'BINDING').value.owner, owner);
    assert.ok(restored.audit.recoveryEvidence.some(ref => ref.sha256 === hash(controlBytes)));
    sign.close();
});
