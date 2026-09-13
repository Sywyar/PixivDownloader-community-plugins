import fs from 'node:fs';
import { api, id, list, policy, prefix, main } from './github.mjs';
import { evaluate } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { versionContext } from './version-review.mjs';
import { gatePath, execution, facts, fingerprint, event, pull, classify } from './platform.mjs';
import { attachDecisions, loadDecisions } from './decisions.mjs';

const managedLabels = new Set(JSON.parse(fs.readFileSync(new URL('labels.json', import.meta.url), 'utf8')).map(row => row.name));
function conclusions(result) {
    return [result.validationPassed, result.riskPassed,
        ['APPROVED', 'SELF_APPROVED'].includes(result.human.status), result.flow === 'READY'];
}

export async function publish(number, context, prepared, call = api, write = api, readGit, resolveVersion = versionContext) {
    const pr = pull(number, call);
    const head = pr.head.sha;
    const identity = { number, head, state: pr.state, merged: pr.merged };
    const checks = [];
    const patch = (checkId, conclusion, summary) => write(prefix + '/check-runs/' + id(checkId), {
        method: 'PATCH', token: process.env.GATE_TOKEN,
        body: { status: 'completed', conclusion, output: { title: 'Community admission', summary } },
    });
    try {
        if (pr.state === 'closed' && classify(pr, list(prefix + '/pulls/' + number + '/files', null, call)) === 'version') {
            return { ...identity, labels: [pr.merged ? 'state:awaiting-apply' : 'state:closed'],
                summary: pr.merged ? 'PR merged. Publication has not been applied.' : 'PR closed without merging. No publication was applied.' };
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
        const collect = () => {
            const input = facts(number, prepared, context.current, call, version);
            return attachDecisions(input, loadDecisions(number, prepared, context.current, call, readGit, undefined, input.after.version));
        };
        const before = collect();
        if (before.after.pr.headSha !== head) throw new Error('PR_HEAD_CHANGED');
        const result = evaluate(prepared, before);
        const after = collect();
        if (fingerprint(before) !== fingerprint(after)) throw new Error('REVIEW_FACTS_CHANGED');
        const states = conclusions(result);
        const summary = 'Operation: ' + (version ? version.checked.operation : 'maintenance') + '\n\nInput: ' + result.snapshot.inputSha256
            + '\n\nHuman review: ' + result.human.status + '\n\nFlow: ' + result.flow
            + (version ? '\n\nPlugin scan: ' + version.report.status + '; blocking findings: ' + result.blockingFindingIds.length
                + '\n\nFinding IDs (first 20): ' + result.blockingFindingIds.slice(0, 20).join(', ')
                + '\n\nRisk declaration: ' + (before.declaration.present ? before.declaration.signals.join(', ') || 'empty' : 'not declared')
                + '\n\nOrganization representation: ' + (version.checked.organizationRepresentationRequired?.length
                    ? 'requires human verification for GitHub organization IDs ' + version.checked.organizationRepresentationRequired.join(', ') : 'not applicable')
                + '\n\nPending archive: ' + version.url + '\n\nThis draft is not publication or SOURCE_REVIEWED.'
                : '\n\nPlugin scan: not applicable to the verified maintenance operation.');
        for (let i = 0; i < checks.length; i++) patch(checks[i], states[i] ? 'success' : 'failure', summary);
        if (fingerprint(before) !== fingerprint(collect())) throw new Error('REVIEW_FACTS_CHANGED');
        for (let i = 0; i < checks.length; i++) {
            const check = call(prefix + '/check-runs/' + checks[i]);
            if (id(check.app.id) !== id(policy.gateApp.id) || check.head_sha !== head || check.status !== 'completed'
                || check.conclusion !== (states[i] ? 'success' : 'failure')) throw new Error('CHECK_READBACK_MISMATCH');
        }
        const labels = [...result.labels, version ? version.checked.operation === 'FIRST_RELEASE' ? 'type:new-plugin' : 'type:update' : 'type:maintenance'];
        // 维护合并没有目录应用动作；只有发布执行器能显示 awaiting-apply/completed。
        if (!version && result.snapshot.state === 'MERGED') labels.splice(labels.indexOf('state:awaiting-apply'), 1);
        return { ...identity, labels, summary };
    } catch (error) {
        const failures = [];
        for (const checkId of checks) {
            try { patch(checkId, 'failure', 'Admission could not be verified. See the trusted workflow log.'); }
            catch (failure) { failures.push(failure.message); }
        }
        console.error('PR #' + number + ': ' + error.message);
        if (failures.length) throw new Error('CHECK_REVOCATION_FAILED: ' + failures.join(', '));
        return { ...identity, labels: ['ci:blocked', 'review:pending'], error: error.message,
            summary: 'Admission could not be verified. See the trusted workflow log. This PR is not ready.' };
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

export async function gate() {
    const context = execution(gatePath);
    const payload = event();
    const numbers = payload.pull_request ? [Number(id(payload.pull_request.number))]
        : payload.inputs?.prNumber ? [Number(id(payload.inputs.prNumber))]
            : list(prefix + '/pulls?state=open&base=' + policy.defaultBranch, null).map(pr => pr.number);
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
