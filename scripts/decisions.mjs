import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, policy, prefix, main } from './github.mjs';
import { evidence, evaluate, hash, readDecisionArtifact, root } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { versionContext } from './version-review.mjs';
import { decisionPath, trustedRun, execution, facts, fingerprint, event, pull } from './platform.mjs';

const decisionTime = value => new Date(value).toISOString().replace(/\.000Z$/u, 'Z');

function decisionName(number, runId, attempt, digest) {
    return 'community-decision-' + number + '-' + runId + '-' + attempt + '-' + digest;
}

// 文件只提供数据；运行来源、身份和当前权限由 API 与受保护 Git 历史独立核对。
export function loadDecisions(number, prepared, current, call = api, readGit, allowRunningRunId, version = null) {
    const currentHead = pull(number, call).head.sha;
    const runs = list(prefix + '/actions/workflows/community-review-decision.yml/runs?event=workflow_dispatch&branch='
        + policy.defaultBranch, 'workflow_runs', call);
    const values = [];
    for (const candidate of runs) {
        const match = /^Community decision PR #([1-9][0-9]*) head ([0-9a-f]{40})$/u.exec(candidate.display_title ?? '');
        if (!match || Number(match[1]) !== number || match[2] !== currentHead) continue;
        let latest;
        try { latest = trustedRun(candidate.id, candidate.run_attempt, decisionPath, current, call, readGit); }
        catch (error) {
            if (error.message === 'WORKFLOW_SOURCE_CHANGED') continue;
            throw error;
        }
        const running = id(candidate.id) === allowRunningRunId;
        if (!running && (latest.status !== 'completed' || latest.conclusion !== 'success')) continue;
        const artifacts = list(prefix + '/actions/runs/' + id(candidate.id) + '/artifacts', 'artifacts', call);
        const attempts = new Set();
        for (const artifact of artifacts) {
            if (!artifact.name.startsWith('community-decision-' + number + '-')) continue;
            const name = new RegExp('^community-decision-' + number + '-' + id(candidate.id) + '-([1-9][0-9]*)-([0-9a-f]{64})$').exec(artifact.name);
            if (!name || artifact.expired || !Number.isSafeInteger(artifact.size_in_bytes)
                || artifact.size_in_bytes > 32 * 1024 * 1024 || id(artifact.workflow_run.id) !== id(candidate.id)) {
                throw new Error('DECISION_ARTIFACT_INVALID');
            }
            const attempt = Number(name[1]);
            if (attempts.has(attempt) || attempt > candidate.run_attempt) throw new Error('DECISION_ATTEMPT_INVALID');
            attempts.add(attempt);
            const run = trustedRun(candidate.id, attempt, decisionPath, current, call, readGit);
            if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('DECISION_RUN_INCOMPLETE');
            const archive = call(prefix + '/actions/artifacts/' + id(artifact.id) + '/zip', { raw: true });
            if (artifact.digest !== 'sha256:' + hash(archive)) throw new Error('DECISION_ARTIFACT_DIGEST');
            const bytes = readDecisionArtifact(prepared, archive);
            if (hash(bytes) !== name[2]) throw new Error('DECISION_BYTES_MISMATCH');
            const document = JSON.parse(bytes.toString('utf8'));
            if (artifact.name !== decisionName(number, id(candidate.id), attempt, hash(bytes))
                || document.prNumber !== number || document.headSha !== match[2]
                || document.workflowSha !== run.head_sha || document.githubRepositoryId !== policy.repositoryId) {
                throw new Error('DECISION_OBJECT_MISMATCH');
            }
            values.push({ document, evidence: evidence(prepared.workspace, bytes), execution: {
                // 原始 base 是可信表单当时取得的事实；当前 binding/策略由每次 facts() 重算。
                pr: { githubRepositoryId: policy.repositoryId, number, authorAccountId: document.prAuthorAccountId,
                    headRepositoryId: document.headRepositoryId, headSha: match[2], baseSha: sha(document.baseSha), mergeSha: null },
                repositoryId: document.repositoryId, version, workflowPath: decisionPath, workflowSha: run.head_sha,
                runId: id(run.id), runAttempt: run.run_attempt,
                originalActor: { id: id(run.actor.id), type: run.actor.type },
                triggeringActor: { id: id(run.triggering_actor.id), type: run.triggering_actor.type },
                decisionAt: decisionTime(run.created_at) } });
        }
        if (!running && !attempts.has(candidate.run_attempt)) throw new Error('DECISION_ARTIFACT_MISSING');
    }
    return values;
}

export function attachDecisions(input, values) {
    const shas = new Set(input.policy.decisionWorkflowShas);
    for (const value of values) {
        input.decisions.push({ evidence: value.evidence, execution: value.execution });
        if (!input.evidence.some(ref => ref.path === value.evidence.path)) input.evidence.push(value.evidence);
        shas.add(value.execution.workflowSha);
    }
    input.policy.decisionWorkflowShas = [...shas].sort();
    return input;
}

export function createDecision(inputs, context, input, previous = []) {
    const number = Number(id(inputs.prNumber));
    if (!Number.isSafeInteger(number) || number !== input.after.pr.number || sha(inputs.expectedHeadSha) !== input.after.pr.headSha
        || input.after.state !== 'OPEN' || input.after.draft) throw new Error('DECISION_CURRENT_PR_REQUIRED');
    const run = context.run;
    if (run.display_title !== 'Community decision PR #' + number + ' head ' + inputs.expectedHeadSha
        || run.actor.type !== 'User' || run.triggering_actor.type !== 'User'
        || !input.policy.reviewerAccountIds.includes(id(run.actor.id))
        || !input.policy.reviewerAccountIds.includes(id(run.triggering_actor.id))) throw new Error('DECISION_REVIEWER_REQUIRED');
    if (typeof inputs.reason !== 'string' || !inputs.reason.trim() || [...inputs.reason].length > 2048) {
        throw new Error('DECISION_REASON_INVALID');
    }
    const self = inputs.action === 'SELF_REVIEW_APPROVED';
    const revoke = inputs.action === 'REVOKE_DECISION';
    const scan = ['FALSE_POSITIVE', 'MANUAL_SCAN_ACCEPTED'].includes(inputs.action);
    if (!self && !revoke && !scan) throw new Error('DECISION_ACTION_INPUT_INVALID');
    const confirmed = inputs.confirmSelfReview === true || inputs.confirmSelfReview === 'true';
    if (self && (!confirmed || id(run.actor.id) !== input.after.pr.authorAccountId || inputs.targetDecisionSha256)
        || revoke && (confirmed || !/^[0-9a-f]{64}$/u.test(inputs.targetDecisionSha256 ?? ''))
        || scan && (confirmed || inputs.targetDecisionSha256)
        || !scan && (inputs.scanRunId || inputs.scanRunAttempt || inputs.findingIds)) {
        throw new Error('DECISION_ACTION_INPUT_INVALID');
    }
    let scanFields = {};
    if (scan) {
        const actual = input.after.scan;
        if (!input.after.version || !actual || !input.report || id(inputs.scanRunId) !== actual.runId
            || Number(id(inputs.scanRunAttempt)) !== actual.runAttempt) throw new Error('DECISION_SCAN_MISMATCH');
        const findingIds = (inputs.findingIds ?? '').split(/[\s,]+/u).filter(Boolean);
        if (inputs.action === 'FALSE_POSITIVE' ? !findingIds.length || new Set(findingIds).size !== findingIds.length : findingIds.length) {
            throw new Error('DECISION_FINDINGS_INVALID');
        }
        scanFields = { scanRunId: actual.runId, scanRunAttempt: actual.runAttempt, scannerVersion: actual.scannerVersion,
            rulesSha256: actual.rulesSha256, reportRef: input.report,
            ...(inputs.action === 'FALSE_POSITIVE' ? { findingIds } : {}) };
    }
    if (revoke && !previous.some(value => value.evidence.sha256 === inputs.targetDecisionSha256
        && value.document.headSha === input.after.pr.headSha)) throw new Error('DECISION_REVOKE_TARGET_MISSING');
    const old = previous.filter(value => value.document.runId === id(run.id)).sort((a, b) => a.document.runAttempt - b.document.runAttempt)[0];
    if (run.run_attempt > 1 && !old) throw new Error('DECISION_ORIGINAL_ARTIFACT_REQUIRED');
    const pr = input.after.pr;
    const actionFields = self ? { reviewMode: 'SELF', selfReview: true }
        : revoke ? { targetDecisionSha256: inputs.targetDecisionSha256 } : scanFields;
    const document = old ? { ...old.document } : {
        schemaVersion: 1, action: inputs.action, reason: inputs.reason, githubRepositoryId: policy.repositoryId,
        repositoryId: input.after.repositoryId, prNumber: number, headRepositoryId: pr.headRepositoryId,
        headSha: pr.headSha, baseSha: pr.baseSha, actorAccountId: id(run.actor.id), actorLoginSnapshot: run.actor.login,
        prAuthorAccountId: pr.authorAccountId, workflowPath: decisionPath, workflowSha: context.current,
        runId: id(run.id), decisionAt: decisionTime(run.created_at),
        ...input.after.version, ...actionFields,
    };
    if (document.action !== inputs.action || document.reason !== inputs.reason || document.headSha !== pr.headSha
        || document.actorAccountId !== id(run.actor.id) || document.workflowSha !== context.current
        || Object.entries({ ...input.after.version, ...actionFields }).some(([key, value]) => !isDeepStrictEqual(document[key], value))) {
        throw new Error('DECISION_RERUN_CHANGED');
    }
    document.runAttempt = run.run_attempt;
    document.triggeringActorAccountId = id(run.triggering_actor.id);
    document.createdAt = decisionTime(run.run_started_at);
    const bytes = Buffer.from(JSON.stringify(document) + '\n', 'utf8');
    if (bytes.length > 65536) throw new Error('DECISION_SIZE_EXCEEDED');
    return { document, bytes };
}

export async function dispatch() {
    const context = execution(decisionPath);
    const prepared = prepareSubmission();
    const inputs = event().inputs;
    const number = Number(id(inputs.prNumber));
    const version = await versionContext(number, prepared, context.current);
    const before = facts(number, prepared, context.current, api, version);
    const previous = loadDecisions(number, prepared, context.current, api, undefined, id(context.run.id), before.after.version);
    const value = createDecision(inputs, context, before, previous);
    value.evidence = evidence(prepared.workspace, value.bytes);
    value.execution = { pr: { ...before.after.pr, baseSha: value.document.baseSha }, repositoryId: before.after.repositoryId,
        version: before.after.version, workflowPath: decisionPath, workflowSha: context.current, runId: id(context.run.id),
        runAttempt: context.run.run_attempt, originalActor: { id: id(context.run.actor.id), type: context.run.actor.type },
        triggeringActor: { id: id(context.run.triggering_actor.id), type: context.run.triggering_actor.type },
        decisionAt: value.document.decisionAt };
    const after = facts(number, prepared, context.current, api, version);
    if (fingerprint(before) !== fingerprint(after)) throw new Error('DECISION_FACTS_CHANGED');
    evaluate(prepared, attachDecisions(after, [...previous, value]));
    const directory = path.join(root, 'target/decision');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'decision.json'), value.bytes);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'artifact=' + decisionName(number, id(context.run.id),
        context.run.run_attempt, hash(value.bytes)) + '\n', 'utf8');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Decision SHA-256: \x60' + hash(value.bytes) + '\x60\n', 'utf8');
}

main(import.meta.url, dispatch);
