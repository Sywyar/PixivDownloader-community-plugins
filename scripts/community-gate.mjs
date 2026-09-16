import fs from 'node:fs';
import { api, id, list, policy, prefix, main } from './github.mjs';
import { evaluate } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { versionContext } from './version-review.mjs';
import { gatePath, execution, facts, fingerprint, event, pull, classify } from './platform.mjs';
import { attachDecisions, loadDecisions } from './decisions.mjs';
import { finalizeReleases } from './publication-releases.mjs';
import { authorizeStatus } from './status-authorization.mjs';

export function appliedProjection(pr, files, result) {
    const recorded = result.receipts?.find(receipt => receipt.prNumber === pr.number && receipt.recordOnly);
    const transferred = recorded && result.receipts.some(receipt => receipt.files.some(file =>
        file.path === `audits/${recorded.reviewContext.checked.requestId}.json`));
    if (recorded && !transferred) return { number: pr.number, head: pr.head.sha, state: pr.state, merged: pr.merged,
        labels: ['state:awaiting-apply'], summary: 'This approval is recorded. Ownership remains unchanged until the other required party submits an approval and that request completes review.' };
    const applied = result.applied && result.receipts.some(receipt => receipt.prNumber === pr.number
        || files.some(file => file.filename.endsWith(`/${receipt.requestId}.json`) || file.filename.includes(`/${receipt.requestId}/`)));
    return { number: pr.number, head: pr.head.sha, state: pr.state, merged: pr.merged,
        labels: [applied ? 'state:completed' : 'state:awaiting-apply'], summary: applied
            ? `Verified generation ${result.sequence} is applied; release state has been read back. Admission checks retain their original results.`
            : 'PR merged. Protected state application or release readback is pending.' };
}

const managedLabels = new Set(JSON.parse(fs.readFileSync(new URL('labels.json', import.meta.url), 'utf8')).map(row => row.name));
function conclusions(result) {
    return [result.validationPassed, result.riskPassed,
        result.authorization === 'SIGNED_OWNER' && result.human.status !== 'CHANGES_REQUESTED'
            || ['APPROVED', 'SELF_APPROVED'].includes(result.human.status), result.flow === 'READY'];
}

export async function publish(number, context, prepared, call = api, write = api, readGit, resolveVersion = versionContext, readApplication = finalizeReleases) {
    const pr = pull(number, call);
    const head = pr.head.sha;
    const identity = { number, head, state: pr.state, merged: pr.merged };
    const checks = [];
    const patch = (checkId, conclusion, summary) => write(prefix + '/check-runs/' + id(checkId), {
        method: 'PATCH', token: process.env.GATE_TOKEN,
        body: { status: conclusion === 'pending' ? 'queued' : 'completed', ...(conclusion === 'pending' ? {} : { conclusion }), output: { title: 'Community admission', summary } },
    });
    try {
        // 关闭后的通知只表达终态，不按更新后的默认分支重新签发合并准入检查。
        if (pr.state === 'closed') {
            if (!pr.merged) return { ...identity, labels: ['state:closed'],
                summary: 'PR closed without merging. No publication was applied.' };
            const files = list(prefix + '/pulls/' + number + '/files', null, call);
            const operation = classify(pr, files);
            if (operation === 'maintenance') return { ...identity, labels: ['type:maintenance', 'state:merged'],
                summary: 'Maintenance PR merged. No publication action is required. Admission checks retain their original results.' };
            if (prepared instanceof Error) throw prepared;
            return appliedProjection(pr, files, await readApplication(context, prepared, { call, readGit, write: false }));
        }
        // 先清除同 head 的旧成功，再读取完整原生事实；任一异常均保留失败。
        for (const name of policy.requiredContexts) {
            const check = write(prefix + '/check-runs', { method: 'POST', token: process.env.GATE_TOKEN,
                body: { name, head_sha: head, status: 'in_progress',
                    external_id: id(context.run.id) + ':' + context.run.run_attempt + ':' + number,
                    details_url: 'https://github.com/' + policy.repository + '/actions/runs/' + id(context.run.id) } });
            checks.push(id(check.id));
            if (id(check.app.id) !== id(policy.gateApp.id) || check.app.slug !== policy.gateApp.slug || check.head_sha !== head) {
                throw new Error('CHECK_PUBLISHER_MISMATCH');
            }
        }
        if (prepared instanceof Error) throw prepared;
        const version = await resolveVersion(number, prepared, context.current, call, readGit);
        const reviewCall = version?.completion?.reviewCall ?? call;
        const collect = () => {
            const input = facts(number, prepared, context.current, reviewCall, version);
            return authorizeStatus(attachDecisions(input, loadDecisions(number, prepared, context.current, reviewCall, readGit, undefined, input.after.version)),
                prepared, context, version, pull(number, reviewCall), call);
        };
        const before = collect();
        if (before.after.pr.headSha !== (version?.completion?.receipt.headSha ?? head)) throw new Error('PR_HEAD_CHANGED');
        const result = evaluate(prepared, before);
        const after = collect();
        if (fingerprint(before) !== fingerprint(after)) throw new Error('REVIEW_FACTS_CHANGED');
        const states = conclusions(result).map(value => value ? 'success' : 'failure');
        if (result.human.status === 'PENDING' && result.authorization !== 'SIGNED_OWNER') states[2] = 'pending';
        if (!pr.draft && (version && !version.completion || states[2] === 'pending') && states[0] === 'success' && states[1] === 'success'
            && states[2] !== 'failure') states[3] = 'pending';
        const summary = 'Operation: ' + (version ? version.checked.operation : 'maintenance') + '\n\nInput: ' + result.snapshot.inputSha256
            + '\n\nHuman review: ' + result.human.status + '\n\nFlow: ' + result.flow
            + '\n\nAuthorization: ' + result.authorization
            + (version?.report ? '\n\nPlugin scan: ' + version.report.status + '; blocking findings: ' + result.blockingFindingIds.length
                + '\n\nFinding IDs (first 20): ' + result.blockingFindingIds.slice(0, 20).join(', ')
                + '\n\nRisk declaration: ' + (before.declaration.present ? before.declaration.signals.join(', ') || 'empty' : 'not declared')
                + '\n\nOrganization representation: ' + (version.checked.organizationRepresentationRequired?.length
                    ? 'requires human verification for GitHub organization IDs ' + version.checked.organizationRepresentationRequired.join(', ') : 'not applicable')
                + '\n\nPending archive: ' + version.url + '\n\nThis draft is not publication or SOURCE_REVIEWED.'
                : '\n\nPlugin scan: not applicable to this operation.')
            + (version && !version.completion ? result.authorization === 'SIGNED_OWNER'
                ? '\n\nWaiting for protected automatic status preparation and exact-head checks.'
                : '\n\nWaiting for a maintainer to run Complete community review for this exact head.' : '')
            + (version?.statusManualReason ? '\n\nCommunity restrictions require human review before restoring this version.' : '')
            + (version && !version.completion && id(pr.head.repo.id) !== policy.repositoryId && pr.maintainer_can_modify !== true
                ? '\n\nPlease enable **Allow edits from maintainers** on this pull request before completing the review.' : '')
            + (version?.checked.recoveryRequired ? '\n\nApplication requires explicit recovery approval in the protected release workflow.' : '')
            + (version && !version.report && version.checked.organizationRepresentationRequired?.length
                ? '\n\nOrganization representation requires human verification: ' + version.checked.organizationRepresentationRequired.join(', ') : '');
        for (let i = 0; i < checks.length; i++) patch(checks[i], states[i], summary);
        if (fingerprint(before) !== fingerprint(collect())) throw new Error('REVIEW_FACTS_CHANGED');
        const latest = pull(number, call);
        if (latest.head.sha !== head || latest.base.sha !== pr.base.sha || latest.state !== pr.state || latest.merged !== pr.merged) throw new Error('PR_OR_BASE_CHANGED');
        for (let i = 0; i < checks.length; i++) {
            const check = call(prefix + '/check-runs/' + checks[i]);
            if (id(check.app.id) !== id(policy.gateApp.id) || check.head_sha !== head
                || check.status !== (states[i] === 'pending' ? 'queued' : 'completed')
                || (states[i] === 'pending' ? check.conclusion != null : check.conclusion !== states[i])) throw new Error('CHECK_READBACK_MISMATCH');
        }
        const type = { FIRST_RELEASE: 'new-plugin', UPDATE: 'update', KEY_ROTATION: 'key-rotation',
            YANK: 'yank', UNYANK: 'unyank', REVOKE: 'revoke', OWNERSHIP_TRANSFER: 'ownership-transfer' }[version?.checked.operation] ?? 'maintenance';
        const labels = [...result.labels, 'type:' + type, ...(version?.checked.recoveryRequired ? ['flow:recovery'] : [])];
        if (states[3] === 'pending') {
            const ready = labels.indexOf('state:ready');
            if (ready >= 0) labels.splice(ready, 1);
            if (result.authorization !== 'SIGNED_OWNER' && !labels.includes('review:pending')) labels.push('review:pending');
        }
        // 维护合并没有目录应用动作；只有发布执行器能显示 awaiting-apply/completed。
        if (!version && result.snapshot.state === 'MERGED') labels.splice(labels.indexOf('state:awaiting-apply'), 1);
        return { ...identity, labels, summary };
    } catch (error) {
        const pending = error.message === 'CANDIDATE_ARCHIVE_PENDING';
        const failures = [];
        for (const checkId of checks) {
            try { patch(checkId, pending ? 'pending' : 'failure', pending
                ? 'Waiting for the verified candidate archive.' : 'Admission could not be verified. See the trusted workflow log.'); }
            catch (failure) { failures.push(failure.message); }
        }
        console.error('PR #' + number + ': ' + error.message);
        if (failures.length) throw new Error('CHECK_REVOCATION_FAILED: ' + failures.join(', '));
        if (pending) return { ...identity, labels: ['review:pending'], summary: 'Waiting for the verified candidate archive. Admission remains pending.' };
        if (pr.state === 'closed' && pr.merged) return { ...identity, labels: ['state:apply-failed'], error: error.message,
            summary: 'Protected state or release readback failed. Admission checks retain their original results; inspect the publication workflow before retrying.' };
        return { ...identity, labels: ['ci:blocked', 'review:pending'], error: error.message,
            summary: error.message === 'CANDIDATE_ARCHIVE_READ_FORBIDDEN'
                ? 'The trusted workflow token cannot read Draft Releases. Its archive-reading job requires Contents write permission. Admission remains blocked.'
                : 'Admission could not be verified. See the trusted workflow log. This PR is not ready.' };
    }
}

export function notify(projections, call = api) {
    for (const projection of projections) {
        const number = Number(id(projection.number));
        const matches = () => {
            const pr = pull(number, call);
            return pr.head.sha === projection.head && (projection.state === undefined || pr.state === projection.state && pr.merged === projection.merged);
        };
        if (!matches()) continue;
        if (!Array.isArray(projection.labels) || projection.labels.some(name => !managedLabels.has(name))) throw new Error('LABEL_PROJECTION_INVALID');
        const current = list(prefix + '/issues/' + number + '/labels', null, call).map(label => label.name);
        for (const label of current.filter(name => managedLabels.has(name) && !projection.labels.includes(name))) {
            call(prefix + '/issues/' + number + '/labels/' + encodeURIComponent(label), { method: 'DELETE' });
        }
        const missing = projection.labels.filter(name => !current.includes(name));
        if (missing.length) call(prefix + '/issues/' + number + '/labels', { method: 'POST', body: { labels: missing } });
        if (typeof projection.summary !== 'string') throw new Error('SUMMARY_PROJECTION_INVALID');
        const marker = '<!-- community-review-summary -->';
        const body = marker + '\nHead: ' + projection.head + '\n\n' + projection.summary;
        if (Buffer.byteLength(body, 'utf8') > 65536) throw new Error('SUMMARY_PROJECTION_SIZE');
        const comments = list(prefix + '/issues/' + number + '/comments', null, call).filter(comment =>
            comment.user?.type === 'Bot' && id(comment.user.id) === '41898282' && comment.body?.startsWith(marker));
        if (comments.length > 1) throw new Error('SUMMARY_COMMENT_AMBIGUOUS');
        if (!matches()) continue;
        if (comments.length) {
            if (comments[0].body !== body) call(prefix + '/issues/comments/' + id(comments[0].id), { method: 'PATCH', body: { body } });
        } else call(prefix + '/issues/' + number + '/comments', { method: 'POST', body: { body } });
    }
}

// 唤醒只定位本次事件对应的 PR；master 代码检查不扫描开放投稿。
export function gateRequests(payload, call = api) {
    if (payload.pull_request) return [Number(id(payload.pull_request.number))];
    if (payload.inputs?.prNumber) return [Number(id(payload.inputs.prNumber))];
    if (!payload.workflow_run) return [];
    const run = call(`${prefix}/actions/runs/${id(payload.workflow_run.id)}`);
    if (id(run.repository.id) !== policy.repositoryId || run.status !== 'completed') throw new Error('GATE_TRIGGER_INVALID');
    const patterns = {
        '.github/workflows/submission-check.yml': /^Submission PR #([1-9][0-9]*)$/u,
        '.github/workflows/community-archive.yml': /^Archive Submission PR #([1-9][0-9]*)$/u,
        '.github/workflows/community-review-event.yml': /^Review PR #([1-9][0-9]*)$/u,
        '.github/workflows/community-review-decision.yml': /^Community decision PR #([1-9][0-9]*) head [a-f0-9]{40}$/u,
        '.github/workflows/community-review-complete.yml': /^Complete community review PR #([1-9][0-9]*) head [a-f0-9]{40}$/u,
    };
    if (!patterns[run.path]) throw new Error('GATE_TRIGGER_INVALID');
    const named = patterns[run.path].exec(run.display_title ?? '');
    // 名称只是定位提示，准入仍独立复核当前 PR、执行来源及全部证据。
    return named ? [Number(id(named[1]))] : [...new Set((run.pull_requests ?? []).map(pr => Number(id(pr.number))))];
}

export async function gate() {
    const context = execution(gatePath);
    const payload = event();
    const numbers = gateRequests(payload);
    if (!numbers.length) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'projections=[]\n', 'utf8');
        return;
    }
    let prepared;
    try { prepared = prepareSubmission(); } catch (error) { prepared = error; }
    const projections = [];
    for (const number of numbers) projections.push(await publish(number, context, prepared));
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'projections=' + JSON.stringify(projections) + '\n', 'utf8');
    if (projections.some(row => row.error)) throw new Error('COMMUNITY_ADMISSION_BLOCKED');
}

main(import.meta.url, () => {
    if (process.argv[2] === 'notify') {
        execution(gatePath);
        notify(JSON.parse(process.env.COMMUNITY_PROJECTIONS));
    } else if (process.argv.length === 2) return gate();
    else throw new Error('USAGE: community-gate.mjs [notify]');
});
