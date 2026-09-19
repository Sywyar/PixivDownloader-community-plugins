import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { api, id, sha, list, prefix, policy, main } from './github.mjs';
import { execution, notificationExecution, emergencyPath, event } from './platform.mjs';
import { forkApi, REVIEW_READBACK_ATTEMPTS } from './apply-result.mjs';
import { checkEmergency, emergencyPull } from './emergency-request.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { operationKeys } from './emergency-authorization.mjs';
import { emergencyState, keyFingerprint } from './emergency-state.mjs';
import { repositoryTree, readBlob, stateReader } from './submission-github.mjs';
import { publisherPath } from './submission-check.mjs';
import { automaticEnvironment } from './status-execution.mjs';
import { hash } from './sdk.mjs';
import { formatRequestInfo, notifyRequestInfo } from './community-comments.mjs';

function requestProjection(pr, request, requestPath, bytes) {
    return { number: pr.number, head: pr.head.sha, state: pr.state, merged: pr.merged, baseRef: policy.emergencyBranch,
        requestInfo: formatRequestInfo({ operation: 'DECLARE_KEY_COMPROMISE', owner: request.payload.owner,
            requestPath, requestSha256: hash(bytes) }, request, pr) };
}

export function emergencyCheck(context, pr, conclusion, summary, call = api, token = process.env.GATE_TOKEN) {
    const result = call(`${prefix}/check-runs`, { method: 'POST', token, body: {
        name: policy.emergencyContext, head_sha: pr.head.sha,
        status: conclusion === 'pending' ? 'in_progress' : 'completed',
        ...(conclusion === 'pending' ? {} : { conclusion }),
        external_id: `${id(context.run.id)}:${context.run.run_attempt}:${pr.number}`,
        details_url: `https://github.com/${policy.repository}/actions/runs/${id(context.run.id)}`,
        output: { title: 'Community emergency declaration', summary },
    } });
    if (id(result.app.id) !== id(policy.gateApp.id) || result.app.slug !== policy.gateApp.slug
        || result.head_sha !== pr.head.sha) throw new Error('CHECK_PUBLISHER_MISMATCH');
    return result;
}

export async function appendEmergency(checked, call = api, wait = delay) {
    const { pr, writes } = checked;
    if (checked.ready) return pr.head.sha;
    if (id(pr.head.repo.id) !== policy.repositoryId && !pr.maintainer_can_modify) throw new Error('MAINTAINER_EDITS_REQUIRED');
    const scoped = forkApi(pr, call), target = `repos/${pr.head.repo.full_name}`;
    const entries = [];
    for (const [file, bytes] of writes) {
        const blob = scoped(`${target}/git/blobs`, { method: 'POST', body: { encoding: 'base64', content: bytes.toString('base64') } });
        entries.push({ path: file, mode: '100644', type: 'blob', sha: sha(blob.sha) });
    }
    const parent = scoped(`${target}/git/commits/${sha(pr.head.sha)}`);
    const tree = scoped(`${target}/git/trees`, { method: 'POST', body: { base_tree: sha(parent.tree.sha), tree: entries } });
    const commit = scoped(`${target}/git/commits`, { method: 'POST', body: { parents: [pr.head.sha], tree: sha(tree.sha),
        message: `chore(community): 登记 ${checked.request.value.payload.owner.publisherId} 泄露密钥\n\n- 绑定原生投稿身份与不可变声明\n- 仅停止后续社区操作授权` } });
    checked.unchanged();
    const branch = () => sha(scoped(`${target}/git/ref/heads/${pr.head.ref}`).object.sha);
    try { scoped(`${target}/git/refs/heads/${pr.head.ref}`, { method: 'PATCH', body: { sha: sha(commit.sha), force: false } }); }
    catch (error) { if (branch() !== commit.sha) throw error; }
    for (let attempt = 1; attempt <= REVIEW_READBACK_ATTEMPTS; attempt++) {
        const actual = emergencyPull(pr.number, call);
        if (branch() !== commit.sha || actual.state !== 'open' || actual.draft || actual.merged
            || actual.base.sha !== pr.base.sha || ![pr.head.sha, commit.sha].includes(actual.head.sha)) throw new Error('EMERGENCY_PR_CHANGED');
        if (actual.head.sha === commit.sha) return commit.sha;
        if (attempt === REVIEW_READBACK_ATTEMPTS) throw new Error('PUBLICATION_HEAD_NOT_VISIBLE');
        await wait(1000);
    }
}

// 与普通准入签发共用队列。封禁生效前撤回开放申请的旧成功，防止手动合并沿用旧状态。
// 这里只处理紧急事件，不参与 master 汇总。随后每个原 PR 按最新状态独立重验。
export function invalidatePending(context, fingerprints, sdk, call = api, token = process.env.GATE_TOKEN) {
    const pending = list(`${prefix}/pulls?state=open&base=${policy.defaultBranch}`, null, call);
    const state = stateReader(sdk, context.current, call);
    const numbers = [];
    for (const pr of pending) {
        const files = list(`${prefix}/pulls/${id(pr.number)}/files`, null, call);
        if (files.length !== pr.changed_files && pr.changed_files !== undefined) throw new Error('PR_FILES_INCOMPLETE');
        if (!files.some(file => /^(?:submissions|key-rotations|version-status-requests|ownership-transfers|generated\/receipts)\//u.test(file.filename))) continue;
        let affected = false;
        try {
            const tree = repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
            const raw = file => readBlob(pr.head.repo.full_name, tree.get(file), call);
            const requests = new Set(files.map(row => row.filename.replace(
                /^(ownership-transfers\/[^/]+\/[a-f0-9]{64})\/approvals\/.*$/u, '$1/proposal.json')));
            for (const file of requests) {
                const operation = file.startsWith('submissions/') ? 'FIRST_RELEASE' : file.startsWith('key-rotations/') ? 'KEY_ROTATION'
                    : file.startsWith('version-status-requests/') ? 'YANK'
                        : file.startsWith('ownership-transfers/') && file.endsWith('/proposal.json') ? 'OWNERSHIP_TRANSFER' : null;
                if (!operation) continue;
                const request = JSON.parse(raw(file));
                if (operation === 'FIRST_RELEASE') {
                    const publisherFile = `publishers/${file.split('/')[1]}/${request.publisherId}.json`;
                    const publisher = state.read(publisherFile, 'PUBLISHER')?.value ?? sdk.document('PUBLISHER', raw(publisherFile), publisherFile).value;
                    request.owner = { accountId: publisher.githubAccount.id, accountType: publisher.githubAccount.type, publisherId: publisher.publisherId };
                }
                const keys = operationKeys(operation, request, owner => {
                    const file = publisherPath(owner);
                    return state.read(file, 'PUBLISHER')?.value ?? sdk.document('PUBLISHER', raw(file), file).value;
                }, operation === 'OWNERSHIP_TRANSFER');
                if (keys.some(key => fingerprints.has(keyFingerprint(key)))) affected = true;
            }
        } catch {
            // 无法识别签名身份的申请必须重验，不能把解析失败当作不受影响。
            affected = true;
        }
        if (!affected) continue;
        const result = call(`${prefix}/check-runs`, { method: 'POST', token, body: {
            name: policy.requiredContexts[0], head_sha: sha(pr.head.sha), status: 'completed', conclusion: 'failure',
            external_id: `${id(context.run.id)}:${context.run.run_attempt}:${pr.number}`,
            output: { title: 'Emergency state changed', summary: 'An emergency declaration requires fresh authorization checks before this request can merge.' },
        } });
        if (id(result.app.id) !== id(policy.gateApp.id) || result.app.slug !== policy.gateApp.slug
            || result.head_sha !== pr.head.sha) throw new Error('CHECK_PUBLISHER_MISMATCH');
        const check = call(`${prefix}/check-runs/${id(result.id)}`);
        if (id(check.app.id) !== id(policy.gateApp.id) || check.head_sha !== pr.head.sha
            || check.status !== 'completed' || check.conclusion !== 'failure') throw new Error('CHECK_READBACK_MISMATCH');
        numbers.push(pr.number);
    }
    return numbers;
}

export async function applyEmergency(context, sdk, number, head, { call = api, wait = delay,
    token = process.env.COMMUNITY_REVIEW_BRANCH_TOKEN } = {}) {
    const initial = emergencyPull(number, call);
    const refresh = affected => {
        const pendingRefresh = [];
        for (const prNumber of affected) {
            try { call(`${prefix}/actions/workflows/community-gate.yml/dispatches`,
                { method: 'POST', body: { ref: policy.defaultBranch, inputs: { prNumber: String(prNumber) } } }); }
            catch { pendingRefresh.push(prNumber); }
        }
        return pendingRefresh;
    };
    if (initial.state === 'closed') {
        if (!initial.merged) return { closed: true, merged: false };
        // 合并已经生效时只恢复检查通知，绝不重新签发声明或重复合并。
        const state = emergencyState(sdk, call);
        const files = list(`${prefix}/pulls/${id(number)}/files`, null, call)
            .filter(file => /^requests\/[1-9][0-9]*\/[^/]+\/[a-f0-9]{64}\.json$/u.test(file.filename));
        if (files.length !== 1 || files[0].status !== 'added') throw new Error('EMERGENCY_FILES_INVALID');
        const raw = state.raw(files[0].filename);
        if (!raw) throw new Error('EMERGENCY_RECORDS_MISSING');
        const request = sdk.document('EMERGENCY_REQUEST', raw, files[0].filename).value;
        for (const key of request.payload.keys) if (!state.readBlock(key.fingerprint)) throw new Error('EMERGENCY_RECORDS_MISSING');
        const affected = invalidatePending(context, new Set(request.payload.keys.map(key => key.fingerprint)), sdk, call);
        state.unchanged();
        return { merged: true, merge: initial.merge_commit_sha, affected, pendingRefresh: refresh(affected),
            projection: requestProjection(initial, request, files[0].filename, raw) };
    }
    emergencyCheck(context, initial, 'pending', 'Verifying native identity, registered keys and exact request bytes.', call);
    let checked;
    try {
        if (!token) throw new Error('REVIEW_BRANCH_CREDENTIAL_REQUIRED');
        const actor = call('user', { token });
        if (actor.type !== 'User' || id(actor.id) !== policy.repositoryOwnerId) throw new Error('STATUS_MERGE_IDENTITY_INVALID');
        checked = checkEmergency(number, head, sdk, context.current, call);
        const preparedHead = await appendEmergency(checked, call, wait);
        checked = checkEmergency(number, preparedHead, sdk, context.current, call);
        if (!checked.ready) throw new Error('EMERGENCY_RECORDS_MISSING');
        // 即使本次重复声明没有新增封禁记录，也不改写旧记录或解除已生效的限制。
        const affected = invalidatePending(context, new Set(checked.request.value.payload.keys.map(key => key.fingerprint)), sdk, call);
        checked.unchanged();
        const success = emergencyCheck(context, checked.pr, 'success', 'GitHub authority and every selected key verified; existing publications remain unchanged.', call);
        const check = call(`${prefix}/check-runs/${id(success.id)}`);
        if (check.head_sha !== preparedHead || check.conclusion !== 'success' || id(check.app.id) !== id(policy.gateApp.id)) throw new Error('CHECK_READBACK_MISMATCH');
        checked.unchanged();
        let failure;
        try { call(`${prefix}/pulls/${id(number)}/merge`, { method: 'PUT', token, body: { sha: preparedHead, merge_method: 'merge',
            commit_title: `chore(community): 生效 ${checked.request.value.payload.owner.publisherId} 泄露密钥声明` } }); }
        catch (error) { failure = error; }
        const actual = emergencyPull(number, call);
        if (actual.head.sha !== preparedHead || !actual.merged || actual.state !== 'closed') throw failure ?? new Error('EMERGENCY_MERGE_BLOCKED');
        const merge = call(`${prefix}/git/commits/${sha(actual.merge_commit_sha)}`);
        if (merge.parents?.length !== 2 || merge.parents[0].sha !== checked.pr.base.sha || merge.parents[1].sha !== preparedHead) throw new Error('REVIEW_MERGE_CHANGED');
        // 不依赖 job token 写入自然触发事件，显式唤醒被撤回的各原申请检查。
        return { merged: true, merge: actual.merge_commit_sha, affected, pendingRefresh: refresh(affected),
            projection: requestProjection(actual, checked.request.value, checked.request.path, checked.request.bytes) };
    } catch (error) {
        const latest = emergencyPull(number, call);
        if (!latest.merged && latest.state === 'open') emergencyCheck(context, latest, 'failure',
            'Emergency declaration could not be verified or merged. Inspect the trusted workflow log; no restriction has been undone.', call);
        throw error;
    }
}

main(import.meta.url, async () => {
    if (process.argv.length === 3 && process.argv[2] === 'notify') {
        notificationExecution(emergencyPath);
        notifyRequestInfo(JSON.parse(process.env.COMMUNITY_REQUEST_INFO));
        return;
    }
    if (process.argv.length !== 2) throw new Error('EMERGENCY_ARGUMENTS');
    const context = execution(emergencyPath);
    automaticEnvironment();
    if (!['pull_request_target', 'workflow_dispatch'].includes(context.run.event)) throw new Error('WORKFLOW_SOURCE_INVALID');
    const payload = event(), pr = payload.pull_request;
    const number = Number(id(pr?.number ?? payload.inputs?.prNumber));
    const head = sha(pr?.head.sha ?? payload.inputs?.expectedHeadSha);
    const { projection, ...result } = await applyEmergency(context, prepareSubmission(), number, head);
    if (projection) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'requestInfo=' + JSON.stringify(projection) + '\n', 'utf8');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, JSON.stringify(result) + '\n', 'utf8');
});
