import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, main, policy, prefix, repository } from './github.mjs';

export function desiredSettings() {
    const ruleset = (name, rules, bypass_actors = [], branch = policy.defaultBranch) => ({ name, target: 'branch', enforcement: 'active',
        conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } }, bypass_actors, rules });
    return {
        repository: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false, allow_auto_merge: false },
        token: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true },
        rulesets: [
            ruleset('community-owner-updates', [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
                [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]),
            ruleset('community-required-checks', [
                { type: 'deletion' }, { type: 'non_fast_forward' },
                { type: 'pull_request', parameters: { allowed_merge_methods: ['merge'],
                    dismiss_stale_reviews_on_push: false, require_code_owner_review: false,
                    require_last_push_approval: false, required_approving_review_count: 0,
                    required_review_thread_resolution: false } },
                { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
                    do_not_enforce_on_create: false,
                    required_status_checks: policy.requiredContexts.map(context => ({ context, integration_id: policy.gateApp.id })) } },
            ]),
            ruleset('community-emergency-owner', [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
                [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }], policy.emergencyBranch),
            ruleset('community-emergency-checks', [
                { type: 'deletion' }, { type: 'non_fast_forward' },
                { type: 'pull_request', parameters: { allowed_merge_methods: ['merge'],
                    dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false,
                    required_approving_review_count: 0, required_review_thread_resolution: false } },
                { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
                    do_not_enforce_on_create: false,
                    required_status_checks: [{ context: policy.emergencyContext, integration_id: policy.gateApp.id }] } },
            ], [], policy.emergencyBranch),
        ],
        environments: {
            release: { wait_timer: 0, prevent_self_review: false, can_admins_bypass: false,
                reviewers: policy.reviewerAccountIds.map(value => ({ type: 'User', id: Number(value) })),
                deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
            'community-gate': { wait_timer: 0, prevent_self_review: false, can_admins_bypass: false, reviewers: [],
                deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
            'community-status': { wait_timer: 0, prevent_self_review: false, can_admins_bypass: false, reviewers: [],
                deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
        },
        deploymentBranch: { name: policy.defaultBranch, type: 'branch' },
    };
}

// 一次性数据分支初始化，不复制 master 的源码或工作流。已有任何同名 ref 都保留。
export function initializeEmergency(call = api) {
    repository(call, { owner: true, publicOnly: true });
    try {
        call(`${prefix}/git/ref/heads/${policy.emergencyBranch}`);
        throw new Error('EMERGENCY_BRANCH_ALREADY_EXISTS');
    } catch (error) {
        if (!/\(HTTP 404\)/u.test(String(error.stderr))) throw error;
    }
    const marker = JSON.stringify({ schemaVersion: 1, kind: 'community-emergency-state', repositoryId: policy.repositoryId }) + '\n';
    const tree = call(`${prefix}/git/trees`, { method: 'POST', body: {
        tree: [{ path: 'state.json', mode: '100644', type: 'blob', content: marker }],
    } });
    const commit = call(`${prefix}/git/commits`, { method: 'POST', body: { tree: sha(tree.sha), parents: [],
        message: 'chore(community): 初始化独立紧急状态数据分支' } });
    call(`${prefix}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${policy.emergencyBranch}`, sha: sha(commit.sha) } });
    if (call(`${prefix}/git/ref/heads/${policy.emergencyBranch}`).object.sha !== commit.sha) throw new Error('EMERGENCY_BRANCH_CHANGED');
    return commit.sha;
}

// GitHub 会补充只读字段及默认参数；逐项核对目标字段，同时拒绝额外 bypass。
function contains(actual, expected) {
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
        && expected.every(item => actual.some(value => contains(value, item)));
    if (expected && typeof expected === 'object') return actual && Object.entries(expected).every(([key, value]) => contains(actual[key], value));
    return actual === expected;
}

export function checkSettings(snapshot, desired = desiredSettings()) {
    const errors = [];
    if (!contains(snapshot.repository, desired.repository)) errors.push('repository merge methods');
    if (!isDeepStrictEqual(snapshot.token, desired.token)) errors.push('default token permissions');
    if (snapshot.collaborators.some(actor => id(actor.id) !== policy.repositoryOwnerId
        && ['admin', 'maintain', 'write'].includes(actor.role_name))) errors.push('unexpected repository writer');
    for (const expected of desired.rulesets) {
        const matches = snapshot.rulesets.filter(rule => rule.name === expected.name);
        if (matches.length !== 1 || !contains(matches[0], expected)) errors.push(expected.name);
    }
    for (const [name, expected] of Object.entries(desired.environments)) {
        const actual = snapshot.environments[name];
        const reviewers = actual?.protection_rules?.find(rule => rule.type === 'required_reviewers');
        if (!actual || actual.can_admins_bypass !== false
            || !contains(actual.deployment_branch_policy, expected.deployment_branch_policy)
            || (reviewers?.prevent_self_review ?? false) !== false
            || !contains((reviewers?.reviewers ?? []).map(row => ({ type: row.type, id: row.reviewer.id })), expected.reviewers)
            || !contains(snapshot.branches[name], [desired.deploymentBranch])) errors.push(`environment ${name}`);
    }
    return errors;
}

export function readSettings(call = api) {
    const snapshot = { repository: repository(call, { publicOnly: true }),
        token: call(`${prefix}/actions/permissions/workflow`),
        collaborators: list(`${prefix}/collaborators?affiliation=all`, null, call),
        rulesets: list(`${prefix}/rulesets`, null, call).map(row => {
            const ruleset = call(`${prefix}/rulesets/${id(row.id)}`);
            for (const rule of ruleset.rules) {
                // GitHub 回读会省略 update 的 false 默认值；显式 true 仍须保留并拒绝。
                if (rule.type === 'update') rule.parameters = { update_allows_fetch_and_merge: false, ...rule.parameters };
            }
            return ruleset;
        }),
        environments: {}, branches: {} };
    const names = list(`${prefix}/environments`, 'environments', call).map(env => env.name);
    for (const name of Object.keys(desiredSettings().environments)) {
        if (!names.includes(name)) continue;
        snapshot.environments[name] = call(`${prefix}/environments/${name}`);
        snapshot.branches[name] = snapshot.environments[name].deployment_branch_policy?.custom_branch_policies
            ? list(`${prefix}/environments/${name}/deployment-branch-policies`, 'branch_policies', call) : [];
    }
    return snapshot;
}

export function configure(call = api) {
    repository(call, { owner: true, publicOnly: true });
    call(`${prefix}/branches/${policy.defaultBranch}`);
    const before = readSettings(call);
    const desired = desiredSettings();
    if (before.collaborators.some(actor => id(actor.id) !== policy.repositoryOwnerId
        && ['admin', 'maintain', 'write'].includes(actor.role_name))) throw new Error('UNEXPECTED_REPOSITORY_WRITER');
    for (const branches of Object.values(before.branches)) {
        if (branches.some(branch => !contains(branch, desired.deploymentBranch))) throw new Error('UNEXPECTED_ENVIRONMENT_BRANCH');
    }
    for (const expected of desired.rulesets) {
        const matches = before.rulesets.filter(rule => rule.name === expected.name);
        if (matches.length > 1) throw new Error('RULESET_IDENTITY_AMBIGUOUS');
        if (matches.length === 1 && contains(matches[0], expected)) continue;
        call(`${prefix}/rulesets${matches.length ? `/${id(matches[0].id)}` : ''}`,
            { method: matches.length ? 'PUT' : 'POST', body: expected });
    }
    if (!contains(before.repository, desired.repository)) call(prefix, { method: 'PATCH', body: desired.repository });
    if (!isDeepStrictEqual(before.token, desired.token)) call(`${prefix}/actions/permissions/workflow`, { method: 'PUT', body: desired.token });
    for (const [name, body] of Object.entries(desired.environments)) {
        if (checkSettings(before).includes(`environment ${name}`)) {
            call(`${prefix}/environments/${name}`, { method: 'PUT', body });
            if (!before.branches[name]?.length) call(`${prefix}/environments/${name}/deployment-branch-policies`,
                { method: 'POST', body: desired.deploymentBranch });
        }
    }
    const errors = checkSettings(readSettings(call));
    if (errors.length) throw new Error(`REPOSITORY_READBACK_MISMATCH: ${errors.join(', ')}`);
}

main(import.meta.url, () => {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--plan', '--check', '--apply', '--initialize-emergency'].includes(args[0])) {
        throw new Error('USAGE: configure-repository.mjs --plan|--check|--apply|--initialize-emergency');
    }
    if (args[0] === '--plan') console.log(JSON.stringify(desiredSettings(), null, 2));
    else if (args[0] === '--apply') configure();
    else if (args[0] === '--initialize-emergency') console.log(initializeEmergency());
    else {
        const errors = checkSettings(readSettings());
        if (errors.length) throw new Error(`REPOSITORY_SETTINGS_MISMATCH: ${errors.join(', ')}`);
        console.log('REPOSITORY_SETTINGS_VERIFIED');
    }
});
