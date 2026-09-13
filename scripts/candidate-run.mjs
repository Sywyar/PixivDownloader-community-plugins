import { api, id, sha, list, policy, prefix, main, API_BYTES } from './github.mjs';
import { git, protectedSource, pull, event } from './platform.mjs';
import { buildPath } from './candidate.mjs';

const marker = 'COMMUNITY_BUILD_EXECUTION ';
export function buildExecution(env = process.env, readGit = git) {
    if (!['pull_request_target', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REPOSITORY !== policy.repository
        || env.GITHUB_REPOSITORY_ID !== policy.repositoryId || env.GITHUB_REPOSITORY_OWNER_ID !== policy.repositoryOwnerId
        || env.GITHUB_REF !== `refs/heads/${policy.defaultBranch}` || env.GITHUB_REF_PROTECTED !== 'true'
        || env.GITHUB_WORKFLOW_REF !== `${policy.repository}/${buildPath}@refs/heads/${policy.defaultBranch}`
        || readGit(['rev-parse', 'HEAD']) !== sha(env.GITHUB_WORKFLOW_SHA)) throw new Error('BUILD_EXECUTION_INVALID');
    return { repositoryId: policy.repositoryId, repositoryOwnerId: policy.repositoryOwnerId,
        workflowPath: buildPath, workflowSha: env.GITHUB_WORKFLOW_SHA,
        runId: id(env.GITHUB_RUN_ID), runAttempt: Number(id(env.GITHUB_RUN_ATTEMPT)) };
}

export function verifyBuildRun(candidate, current, call = api, readGit = git) {
    const runId = id(candidate.runId), attempt = id(candidate.runAttempt);
    const run = call(`${prefix}/actions/runs/${runId}/attempts/${attempt}`);
    const workflow = call(`${prefix}/actions/workflows/${id(run.workflow_id)}`);
    if (id(run.id) !== runId || run.run_attempt !== Number(attempt) || !['pull_request_target', 'workflow_dispatch'].includes(run.event)
        || run.event === 'workflow_dispatch' && (run.head_branch !== policy.defaultBranch || run.head_sha !== candidate.workflowSha)
        || run.status !== 'completed' || run.conclusion !== 'success' || run.path !== buildPath
        || id(run.repository.id) !== policy.repositoryId || id(run.head_repository.id) !== policy.repositoryId
        || id(workflow.id) !== id(run.workflow_id) || workflow.path !== buildPath) throw new Error('BUILD_RUN_INVALID');
    const pr = pull(candidate.pr.number, call);
    if (pr.state !== 'open' || pr.head.sha !== candidate.pr.head || id(pr.head.repo.id) !== candidate.pr.headId) throw new Error('BUILD_PR_CHANGED');
    const jobs = list(`${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs', call)
        .filter(job => job.name === 'Build and scan version');
    if (jobs.length !== 1 || jobs[0].conclusion !== 'success' || id(jobs[0].run_id) !== runId
        || !jobs[0].steps.some(step => step.name === 'Bind protected build execution' && step.conclusion === 'success')) {
        throw new Error('BUILD_JOB_INVALID');
    }
    const logs = call(`${prefix}/actions/jobs/${id(jobs[0].id)}/logs`, { raw: true });
    if (!Buffer.isBuffer(logs) || logs.length > API_BYTES) throw new Error('BUILD_LOG_INVALID');
    const matches = logs.toString('utf8').split(/\r?\n/u).map(line => line.replace(/^\S+\s+/u, ''))
        .filter(line => line.startsWith(marker)).map(line => JSON.parse(line.slice(marker.length)));
    if (matches.length !== 1) throw new Error('BUILD_EXECUTION_MISSING');
    const actual = matches[0];
    for (const name of ['repositoryId', 'repositoryOwnerId', 'workflowPath', 'workflowSha', 'runId', 'runAttempt']) {
        if (candidate[name] !== actual[name]) throw new Error('BUILD_EXECUTION_CHANGED');
    }
    if (actual.prNumber !== candidate.pr.number || actual.headSha !== candidate.pr.head) throw new Error('BUILD_EXECUTION_CHANGED');
    protectedSource(sha(actual.workflowSha), current, readGit);
    return run;
}

main(import.meta.url, () => {
    if (process.argv.length !== 2) throw new Error('BUILD_EXECUTION_ARGUMENTS');
    const context = buildExecution();
    const payload = event();
    const pr = pull(payload.pull_request?.number ?? payload.inputs?.prNumber);
    console.log(marker + JSON.stringify({ ...context, prNumber: Number(id(pr.number)), headSha: sha(pr.head.sha) }));
});
