import { api, id, sha, prefix, policy, list } from './github.mjs';
import { execution, notificationExecution, pull } from './platform.mjs';
import { statusPath } from './archive-proof.mjs';

export function statusExecution(mode, env = process.env, call = api, readGit) {
    const context = (mode === 'notify' ? notificationExecution : execution)(statusPath, env, call, readGit);
    if (!['workflow_run', 'workflow_dispatch'].includes(context.run.event)) throw new Error('STATUS_EXECUTION_INVALID');
    return { ...context, automatic: true };
}

export function statusInputs(context, payload, call = api) {
    if (context.run.event === 'workflow_dispatch') return {
        prNumber: Number(id(payload.inputs?.prNumber)), expectedHeadSha: sha(payload.inputs?.expectedHeadSha),
        reason: 'Signed owner request', recoveryApproved: false, organizationRepresentations: '' };
    const run = call(`${prefix}/actions/runs/${id(payload.workflow_run?.id)}`);
    if (id(run.repository.id) !== policy.repositoryId || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('STATUS_TRIGGER_INVALID');
    const pattern = { '.github/workflows/submission-check.yml': /^Submission PR #([1-9][0-9]*)$/u,
        '.github/workflows/community-review-event.yml': /^Review PR #([1-9][0-9]*)$/u }[run.path];
    const match = pattern?.exec(run.display_title ?? '');
    if (!match) throw new Error('STATUS_TRIGGER_INVALID');
    const pr = pull(match[1], call);
    return { prNumber: pr.number, expectedHeadSha: sha(pr.head.sha), reason: 'Signed owner request',
        recoveryApproved: false, organizationRepresentations: '' };
}

export function statusEnvironment(context, inputs, call = api) {
    if (!context.automatic || context.run.path !== statusPath
        || inputs.recoveryApproved || inputs.organizationRepresentations) throw new Error('STATUS_EXECUTION_INVALID');
    const environment = automaticEnvironment(call);
    return { runId: id(context.run.id), runAttempt: context.run.run_attempt, sourceCommit: context.current,
        inputs, environment, run: context.run, authorization: 'SIGNED_OWNER' };
}

export function automaticEnvironment(call = api) {
    const environment = call(`${prefix}/environments/community-status`);
    if (environment.can_admins_bypass !== false || environment.deployment_branch_policy?.custom_branch_policies !== true
        || environment.protection_rules?.some(rule => rule.type === 'required_reviewers' || rule.type === 'wait_timer')) {
        throw new Error('STATUS_ENVIRONMENT_UNPROTECTED');
    }
    const branches = list(`${prefix}/environments/community-status/deployment-branch-policies`, 'branch_policies', call);
    if (branches.length !== 1 || branches[0].name !== policy.defaultBranch || branches[0].type !== 'branch') throw new Error('STATUS_ENVIRONMENT_UNPROTECTED');
    return environment;
}
