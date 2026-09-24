import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission, withRepositoryFiles, withEmergencyState } from './local-sdk.mjs';
import { signingTool, signOperation } from '../submission-signing.mjs';
import { prepareResult } from '../community-publication.mjs';
import { hash } from '../sdk.mjs';
import { encoded } from '../apply-generation.mjs';
import { policy, prefix } from '../github.mjs';
import { statusPath } from '../archive-proof.mjs';
import { authorizeStatus } from '../status-authorization.mjs';
import { reviewTransfer } from '../submission-transfer.mjs';
import { prValue } from '../platform.mjs';

for (const automatic of [false, true]) test(`真实 SDK ${automatic ? '双边签名自动' : '人工'}转移生成同一 PR 的完整状态，缺失与撤回的确认不授权`, async t => {
    const sdk = prepareSubmission(), sign = signingTool(sdk);
    t.after(() => sign.close());
    const pair = crypto.generateKeyPairSync('ed25519'), keyId = crypto.randomUUID();
    const privateBytes = Buffer.from(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    t.after(() => privateBytes.fill(0));
    const privateFile = path.join(sdk.workspace, 'transfer-test-key.pem');
    fs.writeFileSync(privateFile, privateBytes, { mode: 0o600 });
    const key = { keyId, algorithm: 'Ed25519', publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const from = { accountId: '101', accountType: 'User', publisherId: 'old' }, to = { accountId: '202', accountType: 'User', publisherId: 'next' };
    const ownerPair = crypto.generateKeyPairSync('ed25519'), ownerKeyId = crypto.randomUUID();
    const ownerFile = path.join(sdk.workspace, 'transfer-owner.pem');
    fs.writeFileSync(ownerFile, ownerPair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const publisher = encoded({ schemaVersion: 1, publisherId: from.publisherId, displayName: 'Original',
        githubAccount: { id: from.accountId, type: 'User', loginAtRegistration: 'original' }, signingKeys: [{
            keyId: ownerKeyId, algorithm: 'Ed25519', state: 'ACTIVE', publicKeySpkiBase64: ownerPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] });
    const binding = encoded({ schemaVersion: 1, pluginId: 'demo', owner: from, effectiveRequestId: null, updatedAt: '2026-01-01T00:00:00Z' });
    const request = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload: { pluginId: 'demo', pluginBindingSha256: hash(binding), from, to,
        targetPublisherRecordSha256: null, targetKey: key, targetPublisherDisplayName: 'Next', mode: 'REGULAR', explanation: 'Transfer maintenance' } },
    { targetKey: { keyId, privateFile } });
    const root = `ownership-transfers/demo/${request.requestId}`, file = `${root}/proposal.json`, approvalFile = `${root}/approvals/to/202.json`;
    const records = new Map([['plugin-bindings/demo.json', binding], ['publishers/101/old.json', publisher], [file, encoded(request)],
        [approvalFile, encoded({ schemaVersion: 1, requestId: request.requestId, role: 'TO' })]]);
    const state = { tree: records, raw: file => records.get(file) ?? null,
        read(file, kind) { const bytes = this.raw(file); return bytes ? { ...sdk.document(kind, bytes, file), bytes, path: file } : null; } };
    const checked = { operation: 'OWNERSHIP_TRANSFER', singlePr: true, ownerConfirmationInRequest: false, from, to, pluginId: 'demo',
        requestPath: file, requestId: request.requestId, requestSha256: hash(records.get(file)), bindingSha256: hash(binding), publisherSha256: null,
        recoveryRequired: false, organizationRepresentationRequired: [] };
    const reviewer = { id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' };
    const context = { automatic, current: 'a'.repeat(40), run: { id: '17', run_attempt: 1, event: 'workflow_dispatch',
        path: statusPath, created_at: '2026-01-02T00:00:00Z', triggering_actor: reviewer } };
    const pr = { number: 7, state: 'open', merged: false, draft: false, user: { id: '202', type: 'User' },
        head: { sha: 'b'.repeat(40), repo: { id: '303', full_name: 'recipient/fork' } }, base: { sha: context.current, ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    checked.pr = { user: pr.user, head: pr.head.sha };
    const actor = { id: '101', type: 'User', login: 'original' };
    let reviews = [];
    const comments = [];
    const call = withEmergencyState(withRepositoryFiles(withRepositoryFiles((endpoint, options = {}) => {
        if (endpoint === 'user') return actor;
        if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint === `${prefix}/git/ref/heads/master`) return { object: { sha: context.current } };
        if (endpoint === `${prefix}/pulls/7`) return pr;
        if (endpoint.includes('/issues/7/comments?')) return [comments];
        if (endpoint === `${prefix}/issues/7/comments` && options.method === 'POST') {
            comments.push({ id: '501', user: actor, body: options.body.body }); return comments.at(-1);
        }
        if (endpoint === `${prefix}/pulls/7/reviews` && options.method === 'POST') {
            reviews = [{ id: '100', user: actor, state: 'APPROVED', body: options.body.body, commit_id: options.body.commit_id,
                submitted_at: '2026-01-02T00:00:00Z', pull_request_url: `https://api.github.com/${prefix}/pulls/7` }];
            return reviews[0];
        }
        if (endpoint.includes('/collaborators?')) return [[reviewer]];
        if (endpoint.endsWith('/environments/release')) return { id: 5, can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true },
            protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer }] }] };
        if (endpoint.endsWith('/environments/community-status')) return { can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [] };
        if (endpoint.includes('/deployment-branch-policies?')) return [{ branch_policies: [{ name: policy.defaultBranch, type: 'branch' }], total_count: 1 }];
        if (endpoint.endsWith('/actions/runs/17/approvals')) return [{ state: 'approved', user: reviewer, environments: [{ id: 5, name: 'release' }] }];
        if (endpoint.includes('/pulls/7/reviews?')) return [reviews];
        if (endpoint === 'user/202') return { id: '202', type: 'User', login: 'recipient' };
        assert.fail(endpoint);
    }, policy.repository, new Map([[context.current, new Map([['plugin-bindings/demo.json', binding], ['publishers/101/old.json', publisher]])]])),
    pr.head.repo.full_name, new Map([[pr.head.sha, records]])));
    const prepared = { selected: { pr }, state, requestId: hash(encoded({ requestId: request.requestId, prNumber: 7 })), version: { checked },
        appliedAt: '2026-01-02T00:00:00Z', inputFiles: [file, approvalFile].map(filename => ({ filename, status: 'added' })) };
    const credentials = { privateBytes, communityKey: { ...key, state: 'ACTIVE', publisher: 'Community', trustLabel: 'Community', official: false } };
    const complete = () => prepareResult(context, { recoveryApproved: false, organizationRepresentations: '' }, sdk, prepared, credentials, { call, checkCall: call });
    if (!automatic) await assert.rejects(complete(), /TRANSFER_OWNER_CONFIRMATION_REQUIRED/);
    assert(!fs.existsSync(path.join(sdk.workspace, 'publication.json')));
    const approved = { id: '99', user: { id: '101', type: 'User' }, state: 'APPROVED', commit_id: pr.head.sha,
        submitted_at: '2026-01-01T10:00:00Z', pull_request_url: `https://api.github.com/${prefix}/pulls/7` };
    reviews = [{ ...approved, state: 'DISMISSED' }];
    if (!automatic) await assert.rejects(complete(), /TRANSFER_OWNER_CONFIRMATION_REQUIRED/);
    reviews = [approved];
    if (automatic) {
        const input = { after: { pr: prValue(pr) }, evidence: [] };
        assert.equal(authorizeStatus(input, sdk, context, prepared.version, pr, call).statusAudit, undefined);
        const wizard = { sdk, sign, state, call, snapshot: { repositoryId: policy.repositoryId, base: context.current, actor },
            ui: { task: async (_name, work) => work(), select: async () => 'transferApprove', text: key => key, say() {}, confirm: async () => true } };
        const outcome = await reviewTransfer(wizard, { path: file, value: request, sha256: checked.requestSha256,
            openPr: { number: 7, head: pr.head.sha, url: 'https://github.com/example/pull/7' } },
        { check: async () => checked, proof: async () => ({ keyId: ownerKeyId, privateFile: ownerFile }) });
        assert.equal(outcome.outcome.signed, true);
        const authorized = authorizeStatus(input, sdk, context, prepared.version, pr, call);
        const audit = JSON.parse(fs.readFileSync(path.join(sdk.workspace, authorized.statusAudit.path)));
        assert.equal(audit.authorization, 'SIGNED_OWNER');
        prepared.admission = { input: authorized, result: { authorization: audit.authorization } };
        reviews[0].state = 'DISMISSED';
        assert.equal(authorizeStatus(input, sdk, context, prepared.version, pr, call).statusAudit, undefined);
        await assert.rejects(complete(), /TRANSFER_OWNER_CONFIRMATION_REQUIRED/);
        reviews[0].state = 'APPROVED';
    }
    const result = await complete();
    assert.equal(result.value.recordOnly, false);
    const files = new Map(result.value.files.map(row => [row.path, Buffer.from(row.bytes, 'base64')]));
    assert.deepEqual(JSON.parse(files.get('plugin-bindings/demo.json')).owner, to);
    const audit = JSON.parse(files.get(`audits/${request.requestId}.json`));
    assert.equal(audit.prEvidence.length, 1); assert.equal(audit.prEvidence[0].number, 7); assert.equal(audit.result, 'PREPARED');
    assert.equal(audit.authorization, automatic ? 'SIGNED_OWNER' : undefined);
    assert.ok(files.has('generated/catalog.json')); assert.ok(files.has('revocations.json'));
    assert.deepEqual(JSON.parse(records.get('plugin-bindings/demo.json')).owner, from);
    assert.equal(result.value.reviewContext.checked.singlePr, true);
});
