import fs from 'node:fs';
import { authorizeEmergencyKeys } from './emergency-authorization.mjs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy } from './github.mjs';
import { execution, notificationExecution, git, pull, prValue, reviewers, facts, fingerprint } from './platform.mjs';
import { evaluate, hash } from './sdk.mjs';
import { attachDecisions, loadDecisions } from './decisions.mjs';
import { publicationPath } from './archive-proof.mjs';
import { authorizeStatus, signedStatusAuthority } from './status-authorization.mjs';
import { statusEnvironment } from './status-execution.mjs';
export { publicationPath };

export function mergedRequest(number, current, call = api, readGit = git) {
    const pr = pull(number, call);
    if (!pr.merged || pr.state !== 'closed' || pr.draft) throw new Error('MERGED_REQUEST_REQUIRED');
    readGit(['merge-base', '--is-ancestor', sha(pr.merge_commit_sha), sha(current)]);
    const checks = list(`${prefix}/commits/${sha(pr.head.sha)}/check-runs?filter=latest`, 'check_runs', call);
    for (const name of policy.requiredContexts) {
        const matches = checks.filter(row => row.name === name && id(row.app.id) === id(policy.gateApp.id)
            && row.app.slug === policy.gateApp.slug && row.head_sha === pr.head.sha && row.external_id?.endsWith(':' + pr.number));
        if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') throw new Error('MERGED_ADMISSION_INVALID');
    }
    return { pr, checks };
}

// 从受保护第一父链上的首次新增 commit 反查真实 PR，不能把 approval 路径中的账号当作作者。
export function introducedBy(file, current, call = api, readGit = git) {
    const commits = readGit(['log', '--first-parent', '--diff-filter=A', '--format=%H', sha(current), '--', file]).split(/\r?\n/u).filter(Boolean);
    if (commits.length !== 1) throw new Error('APPROVAL_PROVENANCE_INVALID');
    const commit = sha(commits[0]);
    const matches = list(`${prefix}/commits/${commit}/pulls`, null, call).filter(pr => pr.merge_commit_sha === commit
        && pr.base.ref === policy.defaultBranch && id(pr.base.repo.id) === policy.repositoryId);
    if (matches.length !== 1) throw new Error('APPROVAL_PROVENANCE_INVALID');
    const result = mergedRequest(matches[0].number, current, call, readGit);
    const files = list(`${prefix}/pulls/${result.pr.number}/files`, null, call);
    const added = files.filter(row => row.filename === file && row.status === 'added' && !row.previous_filename);
    if (files.length !== result.pr.changed_files || added.length !== 1 || result.pr.merge_commit_sha !== commit
        || readGit(['rev-parse', `${current}:${file}`]) !== readGit(['rev-parse', `${commit}:${file}`])) throw new Error('APPROVAL_PROVENANCE_INVALID');
    return result;
}

export function publicationEnvironment(context, inputs, call = api) {
    if (context.automatic) return statusEnvironment(context, inputs, call);
    if (context.run.event !== 'workflow_dispatch') throw new Error('PUBLICATION_DISPATCH_REQUIRED');
    const authorized = reviewers(call);
    if (context.run.triggering_actor.type !== 'User' || !authorized.includes(id(context.run.triggering_actor.id))) throw new Error('PUBLICATION_REVIEWER_REQUIRED');
    const environment = call(`${prefix}/environments/release`);
    const required = environment.protection_rules?.find(rule => rule.type === 'required_reviewers');
    if (!required || !required.reviewers?.some(row => row.type === 'User' && authorized.includes(id(row.reviewer.id)))
        || environment.can_admins_bypass !== false || environment.deployment_branch_policy?.custom_branch_policies !== true) throw new Error('PUBLICATION_ENVIRONMENT_UNPROTECTED');
    const branches = list(`${prefix}/environments/release/deployment-branch-policies`, 'branch_policies', call);
    if (branches.length !== 1 || branches[0].name !== policy.defaultBranch || branches[0].type !== 'branch') throw new Error('PUBLICATION_ENVIRONMENT_UNPROTECTED');
    const history = call(`${prefix}/actions/runs/${id(context.run.id)}/approvals`);
    if (!Array.isArray(history)) throw new Error('PUBLICATION_APPROVAL_INVALID');
    const approvals = history.filter(row => row.environments?.some(env => env.name === 'release' && id(env.id) === id(environment.id)));
    if (!approvals.length || approvals.some(row => row.state !== 'approved' || row.user?.type !== 'User'
        || !authorized.includes(id(row.user.id)))) throw new Error('PUBLICATION_APPROVAL_REQUIRED');
    return { runId: id(context.run.id), runAttempt: context.run.run_attempt, sourceCommit: context.current,
        inputs, environment, approvals, authorized, run: context.run };
}

export function operationAuthority({ request, proposal, approvals, context, inputs, adapter, call = api }) {
    const native = publicationEnvironment(context, inputs, call);
    if (context.automatic) return signedStatusAuthority(request, prValue(proposal.pr), adapter, native);
    const approved = [...new Set(native.approvals.map(row => id(row.user.id)))];
    const ref = adapter.archive({ ...native, requestId: request.requestId, proposal, approvals });
    const representations = [];
    const declared = inputs.organizationRepresentations ? inputs.organizationRepresentations.split(',').map(value => value.trim()) : [];
    if (declared.some(value => !/^[1-9][0-9]*:[1-9][0-9]*$/u.test(value)) || new Set(declared).size !== declared.length) throw new Error('ORGANIZATION_REPRESENTATION_INVALID');
    const author = id(proposal.pr.user.id);
    const parties = [request.payload.from, request.payload.to].filter(Boolean);
    const proposalOwner = parties.find(owner => owner.accountType === 'User' && owner.accountId === author
        || owner.accountType === 'Organization' && declared.includes(`${owner.accountId}:${author}`));
    const people = [{ owner: request.payload.owner ?? proposalOwner ?? {
        accountId: request.payload.githubAccount?.id, accountType: request.payload.githubAccount?.type, publisherId: request.payload.publisherId },
        person: id(proposal.pr.user.id) }, ...approvals.map(row => ({ owner: row.role === 'FROM' ? request.payload.from : request.payload.to, person: row.author.id }))];
    for (const { owner, person } of people) if (owner?.accountType === 'Organization') {
        if (!declared.includes(`${owner.accountId}:${person}`)) throw new Error('ORGANIZATION_REPRESENTATION_REQUIRED');
        if (!representations.some(row => isDeepStrictEqual(row.subject, owner) && row.personAccountId === person)) {
            representations.push({ subject: owner, personAccountId: person, evidence: adapter.evidence(ref) });
        }
    }
    if (declared.some(value => !representations.some(row => value === `${row.subject.accountId}:${row.personAccountId}`))) throw new Error('ORGANIZATION_REPRESENTATION_INVALID');
    return { authority: { proposalPr: prValue(proposal.pr), actualAuthor: { id: id(proposal.pr.user.id), type: 'User' },
        representations, approval: { requestId: request.requestId, headSha: proposal.pr.head.sha, reviewerAccountIds: approved,
            recoveryApproved: inputs.recoveryApproved === true, evidence: adapter.evidence(ref) }, authorizedReviewers: native.authorized },
        recoveryEvidence: inputs.recoveryApproved === true ? [ref] : [], reference: ref };
}

export function currentAdmission(number, sdk, context, version, call = api, readGit = git) {
    const reviewCall = version.completion?.reviewCall ?? call;
    const emergency = authorizeEmergencyKeys(sdk, version.checked, context.current, pull(number, reviewCall), call);
    const collect = () => {
        const input = facts(number, sdk, context.current, reviewCall, version);
        if (version.publicationBindingSha256) {
            input.before.bindingSha256 = input.after.bindingSha256 = version.publicationBindingSha256;
            input.validation.bindingSha256 = version.publicationBindingSha256;
        }
        return authorizeStatus(attachDecisions(input, loadDecisions(number, sdk, context.current, reviewCall, readGit, undefined, input.after.version)),
            sdk, context, version, pull(number, reviewCall), call);
    };
    const input = collect(), result = evaluate(sdk, input);
    if (!result.validationPassed || !result.riskPassed
        || !(result.authorization === 'SIGNED_OWNER' && result.human.status !== 'CHANGES_REQUESTED'
            || ['APPROVED', 'SELF_APPROVED'].includes(result.human.status))) throw new Error('PUBLICATION_REVIEW_REQUIRED');
    if (context.automatic && result.authorization !== 'SIGNED_OWNER') throw new Error('STATUS_MANUAL_REVIEW_REQUIRED');
    if (fingerprint(input) !== fingerprint(collect())) throw new Error('REVIEW_FACTS_CHANGED');
    emergency?.unchanged();
    return { input, result };
}

export function archiveAdmission(adapter, sdk, input) {
    for (const ref of input.evidence) adapter.archive(fs.readFileSync(path.join(sdk.workspace, ref.path)), ref.path);
    return adapter.archive(input);
}

export function restoreReview(sdk, state, receipt) {
    const frozen = receipt.reviewContext;
    if (!frozen?.checked) throw new Error('APPLY_REVIEW_MISSING');
    for (const ref of frozen.candidate?.evidence ?? []) {
        const file = receipt.files.find(file => file.path === ref.path);
        const bytes = file ? Buffer.from(file.bytes, 'base64') : state.reference(ref);
        if (bytes.length !== ref.size || hash(bytes) !== ref.sha256) throw new Error('APPLY_RECOVERY_CHANGED');
        const destination = sdk.invoke({ command: 'path', root: sdk.workspace, path: ref.path, mustExist: false }).path;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) {
            if (!fs.readFileSync(destination).equals(bytes)) throw new Error('APPLY_RECOVERY_CHANGED');
        } else fs.writeFileSync(destination, bytes, { flag: 'wx' });
    }
    return frozen;
}

export const publicationExecution = (mode, env, call, readGit) => {
    const run = ['notify', 'finalize-notify'].includes(mode) ? notificationExecution : execution;
    const context = run(['finalize', 'finalize-notify'].includes(mode) ? '.github/workflows/community-publication.yml' : publicationPath, env, call, readGit);
    if (!['workflow_dispatch', 'push'].includes(context.run.event)) throw new Error('PUBLICATION_EXECUTION_INVALID');
    return context;
};
