import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { API_BYTES, id, sha, policy, main } from './github.mjs';
import { git } from './project.mjs';
import { root } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { github, checkedRepository, paged, repositoryTree, readBlob, stateReader } from './submission-github.mjs';
import { validateChanges } from './submission-check.mjs';
import { checkResult } from './apply-result.mjs';
import { checkRenewal, renewalAuthor, renewalFile } from './community-renewal.mjs';

const readOnly = (endpoint, options = {}) => {
    if (options.method && options.method !== 'GET') throw new Error('READ_ONLY_CHECK');
    return github(endpoint, options);
};

export async function checkPull(number, sdk, call = readOnly, fetch, { appliedBase } = {}) {
    const repository = checkedRepository(policy.repository, call);
    if (id(repository.id) !== policy.repositoryId || id(repository.owner.id) !== policy.repositoryOwnerId
        || repository.default_branch !== policy.defaultBranch) throw new Error('GITHUB_REPOSITORY_MISMATCH');
    const endpoint = `repos/${policy.repository}/pulls/${id(number)}`;
    const pull = call(endpoint);
    const snapshot = pr => ({ number: pr.number, state: pr.state, user: { id: id(pr.user.id), type: pr.user.type },
        baseId: id(pr.base.repo.id), baseRef: pr.base.ref, base: sha(pr.base.sha), headId: id(pr.head.repo.id), head: sha(pr.head.sha) });
    const before = snapshot(pull);
    const current = appliedBase ?? sha(call(`repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`).object.sha);
    if (before.baseId !== policy.repositoryId || before.baseRef !== policy.defaultBranch || before.user.type !== 'User' && !renewalAuthor(pull)
        || before.number !== Number(number) || (appliedBase ? before.state !== 'closed' || !pull.merged : before.state !== 'open')) throw new Error('PR_TARGET_INVALID');
    const files = paged(`${endpoint}/files`, call);
    if (files.length !== pull.changed_files || !files.length) throw new Error('PR_FILES_INCOMPLETE');
    if (files.some(file => /^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file.filename))) {
        await checkResult(number, sdk, current, { call });
        return { validation: 'PUBLICATION_RESULT_VALIDATED' };
    }
    if (files.some(file => file.filename === renewalFile)) return checkRenewal(pull, files, current, call);
    const submissionPaths = /^(?:submissions|publishers|assets|key-rotations|version-status-requests|ownership-transfers|ownership-transfer-evidence)\//u;
    if (!files.some(file => submissionPaths.test(file.filename))) return { validation: 'NOT_A_SUBMISSION' };
    const state = stateReader(sdk, current, call);
    const tree = repositoryTree(pull.head.repo.full_name, before.head, call);
    const changes = new Map();
    let total = 0;
    for (const file of files) {
        if (file.status !== 'added' || file.previous_filename) throw new Error('APPEND_ONLY_REQUIRED');
        if (!submissionPaths.test(file.filename)) throw new Error('UNEXPECTED_SUBMISSION_FILE');
        const entry = tree.get(file.filename);
        if (entry?.sha !== file.sha) throw new Error('PR_FILE_CHANGED');
        const bytes = readBlob(pull.head.repo.full_name, entry, call);
        total += bytes.length;
        if (total > API_BYTES) throw new Error('SUBMISSION_SIZE_EXCEEDED');
        changes.set(file.filename, bytes);
    }
    if (appliedBase) for (const [file, bytes] of changes) {
        // 已合并的请求本身不是既有状态；先核对主线仍保留原始输入，再对当前管理状态重新检查。
        if (!state.raw(file)?.equals(bytes)) throw new Error('MERGED_INPUT_CHANGED');
        state.tree.delete(file);
    }
    const organizations = new Set();
    const authorize = (owner, user) => {
        if (owner.accountType === 'User') return owner.accountId === user.id;
        if (owner.accountType !== 'Organization') return false;
        const organization = call(`organizations/${id(owner.accountId)}`);
        if (id(organization.id) !== owner.accountId || organization.type !== 'Organization') return false;
        // 只读 token 无法证明私有组织成员或代表权；留给受保护人工审核，不据此签发身份通过。
        organizations.add(owner.accountId);
        return true;
    };
    const result = await validateChanges({ sdk, state, changes, user: before.user, authorize, call, ...(fetch ? { fetch } : {}) });
    const after = snapshot(call(endpoint));
    const currentBase = sha(call(`repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`).object.sha);
    if (!isDeepStrictEqual(before, after) || currentBase !== current) throw new Error('PR_OR_BASE_CHANGED');
    return { ...result, pr: { ...before, base: current }, organizationRepresentationRequired: [...organizations] };
}

main(import.meta.url, async () => {
    if (process.argv.length !== 2 || process.env.GITHUB_EVENT_NAME !== 'pull_request_target'
        || process.env.GITHUB_REPOSITORY_ID !== policy.repositoryId
        || process.env.GITHUB_REPOSITORY !== policy.repository
        || git(root, 'rev-parse', 'HEAD') !== sha(process.env.GITHUB_WORKFLOW_SHA)) throw new Error('TRUSTED_PR_WORKFLOW_REQUIRED');
    const eventFile = process.env.GITHUB_EVENT_PATH;
    if (!fs.lstatSync(eventFile).isFile() || fs.statSync(eventFile).size > API_BYTES) throw new Error('EVENT_SIZE_EXCEEDED');
    const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
    const sdk = prepareSubmission();
    const result = await checkPull(event.number, sdk);
    const output = path.join(root, 'target/submission-check');
    fs.mkdirSync(output);
    if (result.sourceArchive) fs.copyFileSync(result.sourceArchive, path.join(output, 'source.zip'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
});
