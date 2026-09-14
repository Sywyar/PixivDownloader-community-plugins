import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSdk, evidence, evaluate, root, verifyTool } from '../sdk.mjs';

test('真实 JVM 警告不污染 JSON 输出，非零退出仍携带诊断', () => {
    const sdk = prepareSdk();
    const source = path.join(sdk.workspace, 'JsonProbe.java');
    fs.writeFileSync(source, 'public class JsonProbe { public static void main(String[] args) { '
        + 'System.out.print("{\\"ok\\":true}"); if (args.length > 0) System.exit(7); } }', 'utf8');
    sdk.run('javac', [source]);
    // 合法标签组成不存在的组合，触发真实的 JVM logging warning。
    const args = ['-Xlog:gc+os=warning', '-cp', sdk.workspace, 'JsonProbe'];
    assert.deepEqual(JSON.parse(sdk.run('java', args)), { ok: true });
    assert.throws(() => sdk.run('java', [...args, 'fail']), error => {
        assert.equal(error.status, 7);
        assert.deepEqual(JSON.parse(error.stdout), { ok: true });
        assert.match(error.stderr, /\[warning\]\[logging\]/u);
        return true;
    });
});

test('实际固定 SDK 处理原生审核、自审、拒绝及旧 head', () => {
    const prepared = prepareSdk();
    const pr = { githubRepositoryId: '101', number: 2, authorAccountId: '23', headRepositoryId: '102',
        headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeSha: null };
    const snapshot = { repositoryId: 'community-catalog', pr, version: null, inputSha256: '1'.repeat(64),
        bindingSha256: '2'.repeat(64), policySha256: '3'.repeat(64), state: 'OPEN', draft: false, scan: null, apply: null };
    const policy = { reviewerAccountIds: ['23', '24'], dismissalAccountIds: ['23', '24'],
        decisionWorkflowPath: '.github/workflows/community-review-decision.yml', decisionWorkflowShas: ['c'.repeat(40)] };
    const base = { before: snapshot, after: snapshot, validation: { conclusion: 'SUCCESS', publisherId: '999',
        headSha: pr.headSha, baseSha: pr.baseSha, inputSha256: snapshot.inputSha256,
        bindingSha256: snapshot.bindingSha256, policySha256: snapshot.policySha256 },
        publisherId: '999', policy, reviews: [], decisions: [], report: null, declaration: { present: false, signals: [] }, evidence: [] };
    assert.equal(evaluate(prepared, base).flow, 'NONE');
    const raw = { id: 51, user: { id: 24, type: 'User' }, state: 'APPROVED', commit_id: pr.headSha, submitted_at: '2025-01-01T00:00:00Z' };
    const reference = evidence(prepared.workspace, raw);
    const peer = structuredClone(base);
    peer.evidence.push(reference);
    peer.reviews.push({ id: '51', githubRepositoryId: pr.githubRepositoryId, prNumber: pr.number, reviewer: { id: '24', type: 'User' },
        headSha: raw.commit_id, state: raw.state, submittedAt: raw.submitted_at, evidence: reference, dismissal: null });
    assert.equal(evaluate(prepared, peer).flow, 'READY');
    peer.reviews[0].headSha = 'd'.repeat(40);
    assert.equal(evaluate(prepared, peer).flow, 'NONE');
    peer.reviews[0].state = 'CHANGES_REQUESTED';
    assert.equal(evaluate(prepared, peer).human.status, 'CHANGES_REQUESTED');

    const decision = { schemaVersion: 1, action: 'SELF_REVIEW_APPROVED', reason: 'Reviewed the current change.',
        githubRepositoryId: pr.githubRepositoryId, repositoryId: snapshot.repositoryId, prNumber: pr.number,
        headRepositoryId: pr.headRepositoryId, headSha: pr.headSha, baseSha: pr.baseSha,
        actorAccountId: pr.authorAccountId, actorLoginSnapshot: 'test-author', prAuthorAccountId: pr.authorAccountId,
        triggeringActorAccountId: pr.authorAccountId, workflowPath: policy.decisionWorkflowPath, workflowSha: policy.decisionWorkflowShas[0],
        runId: '71', runAttempt: 1, decisionAt: '2025-01-02T00:00:00Z', createdAt: '2025-01-02T00:00:00Z', reviewMode: 'SELF', selfReview: true };
    const decisionRef = evidence(prepared.workspace, decision);
    const self = structuredClone(base);
    self.evidence.push(decisionRef);
    self.decisions.push({ evidence: decisionRef, execution: { pr, repositoryId: snapshot.repositoryId, version: null,
        workflowPath: decision.workflowPath, workflowSha: decision.workflowSha, runId: decision.runId, runAttempt: decision.runAttempt,
        originalActor: { id: '23', type: 'User' }, triggeringActor: { id: '23', type: 'User' }, decisionAt: decision.decisionAt } });
    assert.equal(evaluate(prepared, self).human.status, 'SELF_APPROVED');
    self.evidence.push(reference);
    self.reviews = peer.reviews;
    assert.equal(evaluate(prepared, self).flow, 'NONE');
    self.reviews = [];
    self.before.draft = self.after.draft = true;
    assert.equal(evaluate(prepared, self).flow, 'NONE');
    self.after = structuredClone(self.before);
    self.after.pr.headSha = 'e'.repeat(40);
    assert.throws(() => evaluate(prepared, self));
});

test('执行前拒绝被替换的工具或发行元数据，固定资源由 SDK 校验', () => {
    const copy = fs.mkdtempSync(path.join(root, 'target/sdk-tamper-'));
    fs.mkdirSync(path.join(copy, 'tools'));
    for (const file of ['sdk-lock.json', 'community-contract.json', 'sdk-tools.jar', 'CommunityReview.java']) {
        fs.copyFileSync(path.join(root, 'tools', file), path.join(copy, 'tools', file));
    }
    fs.writeFileSync(path.join(copy, 'tools/sdk-tools.jar'), 'changed');
    assert.throws(() => verifyTool(copy), /TOOL_HASH/);
    fs.copyFileSync(path.join(root, 'tools/sdk-tools.jar'), path.join(copy, 'tools/sdk-tools.jar'));
    fs.appendFileSync(path.join(copy, 'tools/community-contract.json'), ' ');
    assert.throws(() => verifyTool(copy), /METADATA_HASH/);
    fs.copyFileSync(path.join(root, 'tools/community-contract.json'), path.join(copy, 'tools/community-contract.json'));
    fs.cpSync(path.join(root, 'schemas'), path.join(copy, 'schemas'), { recursive: true });
    fs.appendFileSync(path.join(copy, 'schemas/community/v1/community.schema.json'), ' ');
    assert.throws(() => prepareSdk(copy));
});
