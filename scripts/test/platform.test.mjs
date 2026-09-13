import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { policy, prefix } from '../github.mjs';
import { prepareSdk, evaluate, hash, evidence, readDecisionArtifact } from '../sdk.mjs';
import { trustedRun, execution, classify, facts, decisionPath, gatePath } from '../platform.mjs';
import { createDecision, attachDecisions, loadDecisions } from '../decisions.mjs';
import { publish, notify } from '../community-gate.mjs';

const head = 'a'.repeat(40), current = 'b'.repeat(40);
function fixture() {
    const owner = { id: Number(policy.repositoryOwnerId), login: 'owner', type: 'User', role_name: 'admin' };
    const repo = { id: Number(policy.repositoryId), full_name: policy.repository, owner,
        default_branch: policy.defaultBranch, archived: false, private: false };
    const pr = { number: 7, user: owner, base: { repo, ref: policy.defaultBranch, sha: current },
        head: { repo, sha: head }, changed_files: 1, draft: false, state: 'open', merged: false };
    const run = { id: 71, workflow_id: 91, run_attempt: 1, repository: repo, head_repository: repo,
        head_branch: policy.defaultBranch, head_sha: current, path: decisionPath, event: 'workflow_dispatch',
        actor: owner, triggering_actor: owner, created_at: '2025-01-01T00:00:00Z',
        run_started_at: '2025-01-01T00:00:00Z', status: 'completed', conclusion: 'success',
        display_title: 'Community decision PR #7 head ' + head };
    const state = { repo, pr, run, owner, files: [{ filename: 'README.md', status: 'modified', sha: 'c'.repeat(40) }],
        reviews: [], events: [], runs: [], artifacts: [], checks: new Map(), writes: [], labels: ['custom', 'state:ready'], comments: [] };
    const call = (endpoint, options = {}) => {
        const route = endpoint.replace(/([?&])per_page=100/u, '');
        if (options.method && options.method !== 'GET') {
            state.writes.push({ route, ...options });
            if (route === prefix + '/check-runs') {
                const check = { id: state.checks.size + 1, app: { id: policy.gateApp.id, slug: policy.gateApp.slug }, ...options.body };
                state.checks.set(String(check.id), check); return structuredClone(check);
            }
            if (route.startsWith(prefix + '/check-runs/')) {
                const check = state.checks.get(route.split('/').at(-1)); Object.assign(check, options.body); return structuredClone(check);
            }
            if (route.startsWith(prefix + '/issues/7/labels')) {
                if (options.method === 'DELETE') state.labels = state.labels.filter(label => label !== decodeURIComponent(route.split('/').at(-1)));
                else state.labels.push(...options.body.labels);
                return null;
            }
            if (route === prefix + '/issues/7/comments') {
                const comment = { id: 900 + state.comments.length, user: { id: 41898282, type: 'Bot' }, ...options.body };
                state.comments.push(comment); return comment;
            }
            if (route.startsWith(prefix + '/issues/comments/')) {
                const comment = state.comments.find(row => String(row.id) === route.split('/').at(-1));
                Object.assign(comment, options.body); return comment;
            }
            throw new Error('Unexpected write ' + route);
        }
        if (route === prefix) return structuredClone(repo);
        if (route === prefix + '/branches/' + policy.defaultBranch) return { commit: { sha: current } };
        if (route === prefix + '/pulls/7') return structuredClone(pr);
        if (route === prefix + '/pulls/7/files') return [structuredClone(state.files)];
        if (route === prefix + '/pulls/7/reviews') return [structuredClone(state.reviews)];
        if (route === prefix + '/issues/7/events') return [structuredClone(state.events)];
        if (route === prefix + '/collaborators?affiliation=all') return [[structuredClone(owner)]];
        if (route === prefix + '/actions/workflows/91') return { id: 91, path: run.path };
        if (/\/actions\/runs\/71\/attempts\/[1-9][0-9]*$/u.test(route)) return structuredClone(run);
        if (route.startsWith(prefix + '/actions/workflows/community-review-decision.yml/runs?')) {
            return [{ workflow_runs: structuredClone(state.runs), total_count: state.runs.length }];
        }
        if (route === prefix + '/actions/runs/71/artifacts') return [{ artifacts: structuredClone(state.artifacts), total_count: state.artifacts.length }];
        if (route === prefix + '/actions/artifacts/81/zip') return state.archive;
        if (route.startsWith(prefix + '/check-runs/')) return structuredClone(state.checks.get(route.split('/').at(-1)));
        if (route === prefix + '/issues/7/labels') return [state.labels.map((name, i) => ({ id: 1000 + i, name }))];
        if (route === prefix + '/issues/7/comments') return [structuredClone(state.comments)];
        throw new Error('Unexpected read ' + route);
    };
    return { state, call, readGit: args => args[0] === 'rev-parse' && args[1] === 'HEAD' ? current : 'same-protected-tree',
        context: { current, run } };
}

test('来源和路径边界拒绝候选执行器、错误身份、混合动作及未接入投稿', () => {
    const { state, call, readGit } = fixture();
    assert.equal(trustedRun(71, 1, decisionPath, current, call, readGit).id, 71);
    const env = { GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: policy.repositoryId,
        GITHUB_REF: 'refs/heads/' + policy.defaultBranch, GITHUB_REF_PROTECTED: 'true',
        GITHUB_WORKFLOW_REF: policy.repository + '/' + decisionPath + '@refs/heads/' + policy.defaultBranch,
        GITHUB_WORKFLOW_SHA: current, GITHUB_RUN_ID: '71', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_ACTOR: state.owner.login, GITHUB_TRIGGERING_ACTOR: state.owner.login };
    execution(decisionPath, env, call, readGit);
    assert.throws(() => execution(decisionPath, { ...env, GITHUB_REF: 'refs/heads/candidate' }, call, readGit));
    state.run.head_sha = 'c'.repeat(40);
    assert.throws(() => trustedRun(71, 1, decisionPath, current, call,
        args => args[0] === 'rev-parse' ? args[1] : ''), /SOURCE_CHANGED/);
    state.run.head_sha = current;
    for (const field of ['event', 'path', 'head_branch']) {
        const old = state.run[field]; state.run[field] = 'candidate';
        assert.throws(() => trustedRun(71, 1, decisionPath, current, call, readGit));
        state.run[field] = old;
    }
    assert.equal(classify(state.pr, state.files), 'maintenance');
    state.pr.user = { ...state.owner, id: 123 };
    assert.throws(() => classify(state.pr, state.files), /OWNER_REQUIRED/);
    state.pr.user = state.owner;
    assert.throws(() => classify(state.pr, [{ filename: 'submissions/test.json' }]), /EXECUTOR_UNAVAILABLE/);
    state.pr.changed_files = 2;
    assert.throws(() => classify(state.pr, [...state.files, { filename: 'submissions/test.json' }]), /MIXED/);
    assert.throws(() => classify(state.pr, state.files), /INCOMPLETE/);
    assert.equal(state.writes.length, 0);
});

test('目标事件要求受保护执行上下文，投稿 head 和关闭后的空关联均不替代工作流来源', () => {
    const { state, call, readGit } = fixture();
    const association = { base: structuredClone(state.pr.base),
        head: { ...structuredClone(state.pr.head), ref: 'test/candidate' } };
    Object.assign(state.run, { path: gatePath, event: 'pull_request_target', head_sha: head,
        head_branch: association.head.ref, pull_requests: [association] });
    const env = { GITHUB_REPOSITORY: policy.repository, GITHUB_REPOSITORY_ID: policy.repositoryId,
        GITHUB_REF: 'refs/heads/' + policy.defaultBranch, GITHUB_REF_PROTECTED: 'true',
        GITHUB_WORKFLOW_REF: policy.repository + '/' + gatePath + '@refs/heads/' + policy.defaultBranch,
        GITHUB_WORKFLOW_SHA: current, GITHUB_RUN_ID: '71', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_ACTOR: state.owner.login, GITHUB_TRIGGERING_ACTOR: state.owner.login };
    const protectedGit = args => {
        assert(!args.some(arg => arg.includes(head)), '投稿 head 不属于受保护执行来源');
        return readGit(args);
    };
    assert.equal(execution(gatePath, env, call, protectedGit).run.sourceSha, current);
    assert.throws(() => execution(gatePath, { ...env, GITHUB_WORKFLOW_SHA: head }, call, readGit), /EXECUTION_INVALID/);
    assert.throws(() => trustedRun(71, 1, gatePath, current, call, readGit));
    state.run.pull_requests = [];
    assert.equal(execution(gatePath, env, call, protectedGit).run.sourceSha, current);
    for (const change of [{ GITHUB_REF: 'refs/heads/test/candidate' }, { GITHUB_REF_PROTECTED: 'false' },
        { GITHUB_WORKFLOW_REF: policy.repository + '/' + gatePath + '@refs/heads/test/candidate' }]) {
        assert.throws(() => execution(gatePath, { ...env, ...change }, call, readGit), /EXECUTION_INVALID/);
    }
    state.run.event = 'workflow_dispatch';
    assert.throws(() => execution(gatePath, env, call, readGit), /SOURCE_INVALID/);
    assert.equal(state.writes.length, 0);
});

test('真实 SDK 归约表单和 artifact，并由 App 发布器拒绝陈旧事实与伪来源', async () => {
    const prepared = prepareSdk();
    const { state, call, readGit, context } = fixture();
    const inputs = { prNumber: '7', expectedHeadSha: head, action: 'SELF_REVIEW_APPROVED',
        reason: 'Reviewed the current maintenance change.', confirmSelfReview: true };
    const input = facts(7, prepared, current, call);
    const value = createDecision(inputs, context, input);
    assert.equal(value.document.actorAccountId, policy.repositoryOwnerId);
    for (const change of [{ confirmSelfReview: false }, { expectedHeadSha: 'd'.repeat(40) },
        { reason: '😀'.repeat(2049) }, { scanRunId: '1' }, { action: 'MANUAL_SCAN_ACCEPTED' }]) {
        assert.throws(() => createDecision({ ...inputs, ...change }, context, input));
    }
    state.run.triggering_actor = { ...state.owner, id: 123 };
    assert.throws(() => createDecision(inputs, context, input), /REVIEWER/);
    state.run.triggering_actor = state.owner;
    state.run.run_attempt = 2;
    assert.throws(() => createDecision(inputs, context, input), /ORIGINAL/);
    state.run.run_attempt = 1;
    const archiveDirectory = fs.mkdtempSync(path.join(prepared.workspace, 'archive-'));
    fs.writeFileSync(path.join(archiveDirectory, 'decision.json'), value.bytes);
    const archivePath = path.join(archiveDirectory, 'decision.zip');
    execFileSync('jar', ['--create', '--no-manifest', '--file', archivePath, '-C', archiveDirectory, 'decision.json']);
    state.archive = fs.readFileSync(archivePath);
    assert.deepEqual(readDecisionArtifact(prepared, state.archive), value.bytes);
    assert.throws(() => readDecisionArtifact(prepared, Buffer.alloc(32 * 1024 * 1024 + 1)), /SIZE_EXCEEDED/);
    assert.throws(() => evaluate(prepared, { oversized: 'x'.repeat(32 * 1024 * 1024) }), /SIZE_EXCEEDED/);
    fs.writeFileSync(path.join(archiveDirectory, 'decision.json'), Buffer.concat([value.bytes, Buffer.alloc(65537, 32)]));
    const oversizedZip = path.join(archiveDirectory, 'oversized.zip');
    execFileSync('jar', ['--create', '--no-manifest', '--file', oversizedZip, '-C', archiveDirectory, 'decision.json']);
    assert.throws(() => readDecisionArtifact(prepared, fs.readFileSync(oversizedZip)));
    state.runs = [state.run];
    state.artifacts = [{ id: 81, name: 'community-decision-7-71-1-' + hash(value.bytes),
        expired: false, size_in_bytes: state.archive.length, workflow_run: { id: 71 }, digest: 'sha256:' + hash(state.archive) }];
    let loaded = loadDecisions(7, prepared, current, call, readGit);
    assert.equal(evaluate(prepared, attachDecisions(facts(7, prepared, current, call), loaded)).flow, 'READY');
    const digest = state.artifacts[0].digest;
    state.artifacts[0].digest = 'sha256:' + '0'.repeat(64);
    assert.throws(() => loadDecisions(7, prepared, current, call, readGit), /DIGEST/);
    state.artifacts[0].digest = digest;
    const pending = await publish(7, context, prepared, call, call, readGit);
    assert.equal(pending.error, undefined);
    assert.equal([...state.checks.values()].filter(check => check.conclusion === 'success').length, 4);
    state.pr.state = 'closed';
    const closed = await publish(7, context, prepared, call, call, readGit);
    notify([closed], call);
    state.pr.state = 'open';
    const reopened = await publish(7, context, prepared, call, call, readGit);
    assert.equal(reopened.error, undefined);
    assert(reopened.labels.includes('review:self-approved'));
    assert(reopened.labels.includes('state:ready'));
    state.run.head_sha = 'e'.repeat(40);
    const changedSource = await publish(7, context, prepared, call, call,
        args => args[0] === 'rev-parse' ? args[1] : '');
    assert.equal(changedSource.error, undefined);
    assert(changedSource.labels.includes('review:pending'));
    assert(!changedSource.labels.includes('state:ready'));
    assert.equal([...state.checks.values()].at(-1).conclusion, 'failure');
    state.run.head_sha = current;
    state.pr.head.sha = 'f'.repeat(40);
    const changedHead = await publish(7, context, prepared, call, call, readGit);
    assert.equal(changedHead.error, undefined);
    assert(changedHead.labels.includes('review:pending'));
    assert(!changedHead.labels.includes('state:ready'));
    assert([...state.checks.values()].slice(-4).every(check => check.head_sha === state.pr.head.sha));
    notify([changedHead], call);
    assert(!state.labels.includes('state:closed'));
    assert(state.labels.includes('review:pending'));
    state.pr.head.sha = head;
    state.pr.draft = true;
    const draft = await publish(7, context, prepared, call, call, readGit);
    assert(!draft.labels.includes('state:ready'));
    assert.equal([...state.checks.values()].at(-1).conclusion, 'failure');
    state.pr.draft = false;
    let reviewReads = 0;
    const changing = (route, opts) => {
        if (route.includes('/pulls/7/reviews')) {
            if (++reviewReads === 2) state.pr.draft = true;
        }
        return call(route, opts);
    };
    const changed = await publish(7, context, prepared, changing, call, readGit);
    assert(changed.error);
    assert([...state.checks.values()].slice(-4).every(check => check.conclusion === 'failure'));
    state.pr.draft = false;
    const impostor = (route, opts) => {
        const result = call(route, opts);
        if (opts?.method === 'POST' && route.endsWith('/check-runs')) result.app.id = 999;
        return result;
    };
    assert.equal((await publish(7, context, prepared, call, impostor, readGit)).error, 'CHECK_PUBLISHER_MISMATCH');
    state.files = [{ filename: 'reviews/evidence/forged.json' }];
    assert.equal((await publish(7, context, prepared, call, call, readGit)).error, 'SUBMISSION_EXECUTOR_UNAVAILABLE');
    const projection = { number: 7, head, labels: ['ci:blocked', 'review:pending'], summary: 'Pending review' };
    state.comments.push({ id: 89, user: { id: 123, type: 'User' }, body: '<!-- community-review-summary --> forged' });
    notify([projection], call);
    assert.deepEqual(state.labels.sort(), ['ci:blocked', 'custom', 'review:pending']);
    assert.equal(state.comments.length, 2);
    notify([{ ...projection, summary: 'Blocked after a new decision' }], call);
    assert.equal(state.comments.length, 2);
    assert.equal(state.comments.find(comment => comment.id === 89).body, '<!-- community-review-summary --> forged');
    assert(state.comments.find(comment => comment.user.type === 'Bot').body.endsWith('Blocked after a new decision'));
    const writes = state.writes.length;
    notify([{ number: 7, head: 'f'.repeat(40), labels: ['state:ready'] }], call);
    assert.equal(state.writes.length, writes);
});

test('关闭的维护与版本 PR 只更新终态通知，保留原检查且拒绝过期通知', async () => {
    for (const operation of ['maintenance', 'version']) for (const merged of [false, true]) {
        const { state, call, context } = fixture();
        if (operation === 'version') state.files = [{
            filename: `submissions/${policy.repositoryOwnerId}/sample/2.3.4.json`, status: 'added',
        }];
        Object.assign(state.pr, { state: 'closed', merged });
        state.labels.push('ci:passed', 'review:self-approved');
        for (const name of policy.requiredContexts) {
            const checkId = String(state.checks.size + 1);
            state.checks.set(checkId, { id: checkId, name, head_sha: head, status: 'completed', conclusion: 'success' });
        }
        const checks = structuredClone([...state.checks]);
        const unavailable = () => { throw new Error('Closed PR must not load review sources or rebuild candidates'); };
        const projection = await publish(7, context, new Error('SDK unavailable'), call, call, unavailable, unavailable);
        const labels = !merged ? ['state:closed'] : operation === 'maintenance'
            ? ['type:maintenance', 'state:merged'] : ['state:awaiting-apply'];
        assert.equal(projection.error, undefined);
        assert.deepEqual(projection.labels, labels);
        assert.equal(projection.state, 'closed');
        assert.equal(projection.merged, merged);
        assert.equal(state.writes.length, 0);
        assert.deepEqual([...state.checks], checks);
        notify([projection], call);
        assert.deepEqual(state.labels.sort(), ['custom', ...labels].sort());
        assert.equal(state.comments.length, 1);
        assert(state.comments[0].body.endsWith(projection.summary));
        const writes = state.writes.length;
        notify([projection], call);
        assert.equal(state.writes.length, writes);
        state.pr.merged = !merged;
        notify([projection], call);
        assert.equal(state.writes.length, writes);
        state.pr.merged = merged;
        state.pr.head.sha = 'f'.repeat(40);
        notify([projection], call);
        assert.equal(state.writes.length, writes);
        state.pr.head.sha = head;
        state.pr.state = 'open';
        state.pr.merged = false;
        notify([projection], call);
        assert.equal(state.writes.length, writes);
        assert.deepEqual([...state.checks], checks);
    }
});

test('原生撤销必须有真实账号与理由，评论和普通标签不改变审核', () => {
    const prepared = prepareSdk();
    const { state, call } = fixture();
    state.reviews = [{ id: 51, user: state.owner, state: 'DISMISSED', commit_id: head,
        submitted_at: '2025-01-01T00:00:00Z', pull_request_url: 'https://api.github.com/' + prefix + '/pulls/7' }];
    assert.throws(() => facts(7, prepared, current, call), /DISMISSAL/);
    state.events = [{ id: 61, event: 'review_dismissed', actor: state.owner,
        dismissed_review: { review_id: 51, dismissal_message: 'The concern was resolved.' } }];
    assert.equal(evaluate(prepared, facts(7, prepared, current, call)).human.status, 'PENDING');
    state.events[0].dismissed_review.dismissal_message = ' ';
    assert.throws(() => evaluate(prepared, facts(7, prepared, current, call)));
    state.events[0].dismissed_review.dismissal_message = 'Resolved';
    state.events[0].actor = { ...state.owner, id: 123 };
    assert.throws(() => evaluate(prepared, facts(7, prepared, current, call)));
});

test('版本审核绑定真实报告；误报、补扫、自审和撤销分别生效且旧扫描不放行', async () => {
    const prepared = prepareSdk();
    const { state, call, readGit, context } = fixture();
    state.files = [{ filename: `submissions/${policy.repositoryOwnerId}/sample/2.3.4.json`, status: 'added', sha: 'c'.repeat(40) }];
    const checked = { operation: 'FIRST_RELEASE', pr: { head, base: current, user: { id: policy.repositoryOwnerId } },
        submissionSha256: 'd'.repeat(64), submission: { source: { commit: 'e'.repeat(40) } },
        package: { sha256: 'f'.repeat(64) }, descriptor: { riskDeclaration: { present: false, signals: [] } },
        bindingSha256: '1'.repeat(64), publisherSha256: '2'.repeat(64), owner: { accountId: policy.repositoryOwnerId } };
    const raw = evidence(prepared.workspace, { owner: 'java.nio.file.Files', method: 'delete' });
    const report = { schemaVersion: 1, status: 'INCOMPLETE', scannerVersion: 'test-scanner', rulesSha256: '3'.repeat(64),
        runId: '301', runAttempt: 1, headSha: head, sourceCommit: checked.submission.source.commit,
        packageSha256: checked.package.sha256, failureReason: 'CLASS_SCAN_FAILED', observations: [{ observationId: 'call-delete',
            signal: 'FILE_DELETE', origin: 'PLUGIN', location: { archivePath: 'sample.class', className: 'example.Sample',
                methodName: 'run', methodDescriptor: '()V', bytecodeOffset: 12 }, evidence: [raw] }],
        findings: [{ findingId: 'missing-delete', ruleId: 'risk-declaration', signal: 'FILE_DELETE', kind: 'DECLARATION_MISSING',
            observationIds: ['call-delete'], evidence: [raw] }] };
    const version = { checked, report, url: 'https://github.com/example/draft', candidate: { inputSha256: '4'.repeat(64), scan: {}, evidence: [] } };
    const refresh = () => {
        const ref = evidence(prepared.workspace, report);
        version.candidate.scan.riskReportRef = ref;
        version.candidate.evidence = [raw, ref];
        return facts(7, prepared, current, call, version);
    };
    const input = refresh();
    const values = [];
    const decide = (action, fields = {}) => {
        const run = { ...context.run, id: 400 + values.length };
        const value = createDecision({ prNumber: '7', expectedHeadSha: head, reason: 'Checked exact evidence', action, ...fields },
            { ...context, run }, input, values);
        value.evidence = evidence(prepared.workspace, value.bytes);
        value.execution = { pr: input.after.pr, repositoryId: input.after.repositoryId, version: input.after.version,
            workflowPath: decisionPath, workflowSha: current, runId: String(run.id), runAttempt: 1,
            originalActor: { id: policy.repositoryOwnerId, type: 'User' }, triggeringActor: { id: policy.repositoryOwnerId, type: 'User' },
            decisionAt: value.document.decisionAt };
        values.push(value); return value;
    };
    const result = (entries = values) => evaluate(prepared, attachDecisions(structuredClone(input), entries));
    decide('SELF_REVIEW_APPROVED', { confirmSelfReview: true });
    assert.equal(result().human.status, 'SELF_APPROVED');
    assert.equal(result().riskPassed, false);
    const manual = decide('MANUAL_SCAN_ACCEPTED', { scanRunId: '301', scanRunAttempt: '1' });
    assert.deepEqual(result().blockingFindingIds, ['missing-delete']);
    const falsePositive = decide('FALSE_POSITIVE', { scanRunId: '301', scanRunAttempt: '1', findingIds: 'missing-delete' });
    assert.equal(result().flow, 'READY');
    const reportBytes = fs.readFileSync(path.join(prepared.workspace, input.report.path));
    assert.equal(hash(reportBytes), input.report.sha256);
    assert.equal(JSON.parse(reportBytes).findings.length, 1);
    decide('REVOKE_DECISION', { targetDecisionSha256: falsePositive.evidence.sha256 });
    assert.deepEqual(result().blockingFindingIds, ['missing-delete']);
    assert.throws(() => createDecision({ prNumber: '7', expectedHeadSha: head, reason: 'Wrong scan', action: 'FALSE_POSITIVE',
        scanRunId: '301', scanRunAttempt: '2', findingIds: 'missing-delete' }, context, input), /SCAN_MISMATCH/);
    const invalid = decide('FALSE_POSITIVE', { scanRunId: '301', scanRunAttempt: '1', findingIds: 'absent' });
    assert.throws(() => result([values[0], manual, invalid]));
    const passed = await publish(7, context, prepared, call, call, readGit, async () => version);
    assert.equal(passed.error, undefined);
    assert(passed.labels.includes('scan:incomplete'));
    assert(passed.labels.includes('type:new-plugin'));
    report.runAttempt = 2;
    const rescanned = evaluate(prepared, attachDecisions(refresh(), [values[0], manual, falsePositive]));
    assert.equal(rescanned.riskPassed, false);
    assert.deepEqual(rescanned.blockingFindingIds, ['missing-delete']);
    state.pr.head.sha = '9'.repeat(40);
    assert.throws(() => facts(7, prepared, current, call, version), /VERSION_FACTS_CHANGED/);
});
