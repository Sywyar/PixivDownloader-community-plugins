import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { api, id, sha, list, policy, prefix, repository, API_BYTES, API_TIMEOUT } from './github.mjs';
import { root, hash, evidence } from './sdk.mjs';

export const decisionPath = '.github/workflows/community-review-decision.yml';
export const gatePath = '.github/workflows/community-gate.yml';
export const catalogId = 'pixivdownloader-community';
const surface = ['.github', 'scripts', 'tools', 'schemas', 'package.json'];

export function git(args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
        timeout: API_TIMEOUT, maxBuffer: API_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function protectedSource(commit, current, readGit = git) {
    sha(commit); sha(current);
    readGit(['merge-base', '--is-ancestor', commit, current]);
    for (const name of surface) {
        if (readGit(['rev-parse', commit + ':' + name]) !== readGit(['rev-parse', current + ':' + name])) {
            throw new Error('WORKFLOW_SOURCE_CHANGED');
        }
    }
}

// 来源只能是当前仓库默认分支的原生运行；候选文件和 display_title 不能认证执行器。
export function trustedRun(runId, attempt, workflowPath, current, call = api, readGit = git, executionSha) {
    const run = call(prefix + '/actions/runs/' + id(runId) + '/attempts/' + id(attempt));
    const workflow = call(prefix + '/actions/workflows/' + id(run.workflow_id));
    if (id(run.id) !== id(runId) || run.run_attempt !== Number(attempt)
        || id(run.repository.id) !== policy.repositoryId || id(run.head_repository.id) !== policy.repositoryId
        || workflow.path !== workflowPath || id(workflow.id) !== id(run.workflow_id)
        || run.path !== workflowPath
        || (workflowPath === decisionPath && run.event !== 'workflow_dispatch')
        || (workflowPath === gatePath && !['pull_request_target', 'workflow_run', 'workflow_dispatch', 'push'].includes(run.event))) {
        throw new Error('WORKFLOW_SOURCE_INVALID');
    }
    let sourceSha = run.head_sha;
    if (workflowPath === gatePath && run.event === 'pull_request_target') {
        // run head 属于投稿，关闭后原生 PR 关联还会为空；仅使用已交叉验证的当前执行上下文。
        sourceSha = sha(executionSha);
    } else if (run.head_branch !== policy.defaultBranch) throw new Error('WORKFLOW_SOURCE_INVALID');
    protectedSource(sha(sourceSha), current, readGit);
    return { ...run, sourceSha };
}

export function execution(workflowPath, env = process.env, call = api, readGit = git) {
    repository(call, { publicOnly: true });
    const current = sha(call(prefix + '/branches/' + policy.defaultBranch).commit.sha);
    if (env.GITHUB_REPOSITORY !== policy.repository || env.GITHUB_REPOSITORY_ID !== policy.repositoryId
        || env.GITHUB_REF !== 'refs/heads/' + policy.defaultBranch || env.GITHUB_REF_PROTECTED !== 'true'
        || env.GITHUB_WORKFLOW_REF !== policy.repository + '/' + workflowPath + '@refs/heads/' + policy.defaultBranch
        || readGit(['rev-parse', 'HEAD']) !== current || env.GITHUB_WORKFLOW_SHA !== current) {
        throw new Error('WORKFLOW_EXECUTION_INVALID');
    }
    const run = trustedRun(env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, workflowPath, current, call, readGit,
        env.GITHUB_WORKFLOW_SHA);
    if (run.sourceSha !== current || run.actor.login !== env.GITHUB_ACTOR
        || run.triggering_actor.login !== env.GITHUB_TRIGGERING_ACTOR) throw new Error('WORKFLOW_ACTOR_INVALID');
    return { current, run };
}

export function pull(number, call = api) {
    const value = call(prefix + '/pulls/' + id(number));
    if (value.number !== Number(number) || id(value.base.repo.id) !== policy.repositoryId
        || value.base.ref !== policy.defaultBranch || !value.head.repo || value.user.type !== 'User') {
        throw new Error('PR_TARGET_INVALID');
    }
    return value;
}

export function prValue(pr) {
    return { githubRepositoryId: policy.repositoryId, number: pr.number, authorAccountId: id(pr.user.id),
        headRepositoryId: id(pr.head.repo.id), headSha: sha(pr.head.sha), baseSha: sha(pr.base.sha),
        mergeSha: pr.merged ? sha(pr.merge_commit_sha) : null };
}

export function reviewers(call = api) {
    const collaborators = list(prefix + '/collaborators?affiliation=all', null, call);
    return collaborators.filter(user => user.type === 'User' && policy.reviewerAccountIds.includes(id(user.id))
        && ['admin', 'maintain', 'write'].includes(user.role_name)).map(user => id(user.id)).sort();
}

export function classify(pr, files) {
    if (files.length !== pr.changed_files || !files.length || new Set(files.map(f => f.filename)).size !== files.length) {
        throw new Error('PR_FILES_INCOMPLETE');
    }
    const paths = files.flatMap(file => file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]);
    if (paths.some(name => typeof name !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..'))) {
        throw new Error('PR_PATH_INVALID');
    }
    const isMaintenance = name => /^(?:\.github|scripts|tools|schemas)\//u.test(name)
        || ['.gitignore', '.gitattributes', 'README.md', 'README_en.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json'].includes(name);
    if (paths.every(isMaintenance)) {
        if (id(pr.user.id) !== policy.repositoryOwnerId || id(pr.head.repo.id) !== policy.repositoryId) {
            throw new Error('PROTECTED_PATH_OWNER_REQUIRED');
        }
        return 'maintenance';
    }
    const versionPaths = /^(?:submissions\/[1-9][0-9]*\/[a-z0-9][a-z0-9._-]*\/[^/]+\.json|publishers\/[1-9][0-9]*\/[a-z0-9][a-z0-9._-]*\.json|assets\/.+)$/u;
    if (paths.every(name => versionPaths.test(name)) && files.every(file => file.status === 'added')
        && paths.filter(name => name.startsWith('submissions/')).length === 1) return 'version';
    throw new Error(paths.some(isMaintenance) ? 'MIXED_OPERATION' : 'SUBMISSION_EXECUTOR_UNAVAILABLE');
}

export function facts(number, prepared, current, call = api, versionContext = null) {
    const pr = pull(number, call);
    const files = list(prefix + '/pulls/' + pr.number + '/files', null, call);
    const operation = classify(pr, files);
    if (operation === 'version' && (!versionContext || versionContext.checked.pr.head !== pr.head.sha
        || versionContext.checked.pr.base !== pr.base.sha || versionContext.checked.pr.user.id !== id(pr.user.id))) {
        throw new Error('VERSION_FACTS_CHANGED');
    }
    const authorized = reviewers(call);
    const rawReviews = list(prefix + '/pulls/' + pr.number + '/reviews', null, call);
    const dismissals = rawReviews.some(review => review.state === 'DISMISSED')
        ? list(prefix + '/issues/' + pr.number + '/events', null, call).filter(event => event.event === 'review_dismissed') : [];
    const references = [];
    const add = raw => {
        const ref = evidence(prepared.workspace, raw);
        if (!references.some(row => row.path === ref.path)) references.push(ref);
        return ref;
    };
    const reviews = rawReviews.filter(review => review.state !== 'PENDING').map(review => {
        if (review.pull_request_url !== 'https://api.github.com/' + prefix + '/pulls/' + pr.number) throw new Error('REVIEW_SOURCE_INVALID');
        let dismissal = null;
        if (review.state === 'DISMISSED') {
            const matches = dismissals.filter(event => id(event.dismissed_review.review_id) === id(review.id));
            if (matches.length !== 1 || matches[0].actor.type !== 'User') throw new Error('REVIEW_DISMISSAL_MISSING');
            const event = matches[0];
            dismissal = { actorAccountId: id(event.actor.id), reason: event.dismissed_review.dismissal_message, evidence: add(event) };
        }
        return { id: id(review.id), githubRepositoryId: policy.repositoryId, prNumber: pr.number,
            reviewer: { id: id(review.user.id), type: review.user.type }, headSha: sha(review.commit_id),
            state: review.state, submittedAt: review.submitted_at, evidence: add(review), dismissal };
    });
    const reviewPolicy = { reviewerAccountIds: authorized, dismissalAccountIds: authorized,
        decisionWorkflowPath: decisionPath, decisionWorkflowShas: [current] };
    const version = versionContext?.checked;
    const report = versionContext?.report;
    if (versionContext) for (const ref of versionContext.candidate.evidence) {
        if (!references.some(row => row.path === ref.path)) references.push(ref);
    }
    const snapshot = { repositoryId: catalogId, pr: prValue(pr), version: version ? {
        submissionSha256: version.submissionSha256, sourceCommit: version.submission.source.commit, packageSha256: version.package.sha256 } : null,
        inputSha256: hash(Buffer.from(JSON.stringify({ operation, files, candidate: versionContext?.candidate.inputSha256 ?? null }))),
        bindingSha256: hash(Buffer.from(version ? JSON.stringify([version.bindingSha256, version.publisherSha256, version.owner]) : 'maintenance')),
        policySha256: hash(Buffer.from(JSON.stringify({ policy, authorized }))),
        state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED', draft: pr.draft, scan: report ? {
            runId: report.runId, runAttempt: report.runAttempt, scannerVersion: report.scannerVersion, rulesSha256: report.rulesSha256,
            conclusion: report.status === 'COMPLETE' ? 'SUCCESS' : 'FAILURE' } : null, apply: null };
    return { before: snapshot, after: structuredClone(snapshot),
        validation: { conclusion: 'SUCCESS', publisherId: id(policy.gateApp.id), headSha: snapshot.pr.headSha,
            baseSha: snapshot.pr.baseSha, inputSha256: snapshot.inputSha256, bindingSha256: snapshot.bindingSha256,
            policySha256: snapshot.policySha256 }, publisherId: id(policy.gateApp.id), policy: reviewPolicy,
        reviews, decisions: [], report: versionContext?.candidate.scan.riskReportRef ?? null,
        declaration: version?.descriptor.riskDeclaration ?? { present: false, signals: [] }, evidence: references };
}

export function fingerprint(input) {
    return hash(Buffer.from(JSON.stringify({ snapshot: input.after, policy: input.policy,
        reviews: input.reviews, decisions: input.decisions })));
}

export function event() {
    const bytes = fs.readFileSync(process.env.GITHUB_EVENT_PATH);
    if (bytes.length > API_BYTES) throw new Error('EVENT_SIZE_EXCEEDED');
    return JSON.parse(bytes.toString('utf8'));
}
