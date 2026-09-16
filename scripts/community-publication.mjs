import fs from 'node:fs';
import path from 'node:path';
import { api, id, sha, list, prefix, policy, main, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { event, prValue, reviewers, pull } from './platform.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { stateReader, github } from './submission-github.mjs';
import { versionContext } from './version-review.mjs';
import { applySdk } from './apply-sdk.mjs';
import { applyOperation } from './apply-operations.mjs';
import { publishVersion } from './apply-version.mjs';
import { generateState, encoded } from './apply-generation.mjs';
import { publicationExecution, publicationEnvironment, introducedBy, operationAuthority, currentAdmission, archiveAdmission, restoreReview } from './apply-context.mjs';
import { makeReceipt, receiptPath, receiptExpired, readReceipt, immutableAsset, appendReviewCommit, reviewPrerequisite, checkResult } from './apply-result.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { finalizeReleases } from './publication-releases.mjs';
import { notify, appliedProjection } from './community-gate.mjs';

const output = value => {
    for (const [key, item] of Object.entries(value)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${item}\n`, 'utf8');
};
export const inputsFrom = payload => {
    const value = payload.inputs ?? {};
    if (typeof value.reason !== 'string' || !value.reason.trim() || [...value.reason].length > 2048) throw new Error('DECISION_REASON_INVALID');
    if (![undefined, false, true, 'false', 'true'].includes(value.recoveryApproved)) throw new Error('PUBLICATION_INPUT_INVALID');
    return { prNumber: Number(id(value.prNumber)), expectedHeadSha: sha(value.expectedHeadSha), reason: value.reason,
        recoveryApproved: value.recoveryApproved === true || value.recoveryApproved === 'true',
        organizationRepresentations: value.organizationRepresentations ?? '' };
};

export async function preparePublication(context, inputs, sdk, { call = api, checkCall = github, readGit } = {}) {
    if (context.run.event !== 'workflow_dispatch') throw new Error('PUBLICATION_DISPATCH_REQUIRED');
    if (!reviewers(call).includes(id(context.run.triggering_actor.id))) throw new Error('PUBLICATION_REVIEWER_REQUIRED');
    const pr = pull(inputs.prNumber, call);
    const pending = reviewPrerequisite(pr, inputs.expectedHeadSha, context.current);
    if (pending) return { selected: { pr }, pending };
    const files = list(`${prefix}/pulls/${pr.number}/files`, null, call);
    if (files.some(file => /^generated\/receipts\//u.test(file.filename))) {
        const completion = await checkResult(pr.number, sdk, context.current, { call, readGit });
        const frozen = { ...restoreReview(sdk, stateReader(sdk, context.current, checkCall), completion.receipt), completion };
        currentAdmission(pr.number, sdk, context, frozen, call, readGit);
        return { selected: { pr }, replayed: true, receipt: completion.receipt };
    }
    const version = await versionContext(pr.number, sdk, context.current, call, readGit, { checkCall });
    if (!version) return { selected: { pr }, pending: 'REVIEW_OPERATION_REQUIRED' };
    const state = stateReader(sdk, pr.head.sha, checkCall, pr.head.repo.full_name);
    const appliedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const identity = version.checked.submissionSha256 ?? (version.checked.operation === 'OWNERSHIP_TRANSFER'
        ? hash(encoded({ requestId: version.checked.requestId, prNumber: pr.number })) : version.checked.requestSha256);
    if (version.checked.submission) {
        const bindingPath = `plugin-bindings/${version.checked.submission.pluginId}.json`;
        const bindingBytes = state.raw(bindingPath) ?? encoded({ schemaVersion: 1, pluginId: version.checked.submission.pluginId,
            owner: version.checked.owner, effectiveRequestId: null, updatedAt: appliedAt });
        sdk.document('BINDING', bindingBytes, bindingPath);
        version.publicationBindingSha256 = hash(bindingBytes);
    }
    let admission;
    try { admission = currentAdmission(pr.number, sdk, context, version, call, readGit); }
    catch (error) { if (error.message === 'PUBLICATION_REVIEW_REQUIRED') return { selected: { pr }, pending: error.message }; throw error; }
    return { selected: { pr }, state, requestId: identity, inputFiles: files, version, admission, appliedAt };
}
export async function prepareResult(context, inputs, sdk, prepared, credentials, { call = api, checkCall = github, readGit } = {}) {
    publicationEnvironment(context, inputs, call);
    if (prepared.replayed) return { replayed: true, receipt: prepared.receipt };
    const { selected, state, requestId, version, admission, appliedAt } = prepared;
    const adapter = applySdk(sdk);
    if (admission) archiveAdmission(adapter, sdk, admission.input);
    const communityKey = credentials.communityKey;
    const nextUpdate = new Date(Date.parse(appliedAt) + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    let applied;
    if (version.checked.operation === 'RENEWAL') {
        applied = { writes: new Map(), decision: adapter.archive({ ...publicationEnvironment(context, inputs, call),
            operation: 'RENEWAL', requestSha256: version.checked.requestSha256 }) };
    } else if (version.checked.submission) applied = publishVersion({ sdk, adapter, state, version, pr: selected.pr, context,
        admission, inputs, communityKey, privateBytes: credentials.privateBytes, appliedAt, call });
    else {
        const checked = version.checked;
        const request = state.read(checked.requestPath, checked.operation === 'KEY_ROTATION' ? 'ROTATION'
            : checked.operation === 'OWNERSHIP_TRANSFER' ? 'TRANSFER' : 'STATUS_REQUEST').value;
        const native = file => prepared.inputFiles.some(row => row.filename === file)
            ? selected : introducedBy(file, context.current, call, readGit);
        const proposal = native(checked.requestPath);
        const approvals = [];
        if (checked.operation === 'OWNERSHIP_TRANSFER') {
            const directory = `ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/`;
            for (const file of state.tree.keys()) if (file.startsWith(directory) && file.endsWith('.json')) {
                const record = state.read(file, 'APPROVAL');
                const origin = native(file);
                approvals.push({ reference: adapter.archive(record.bytes, file), role: record.value.role,
                    pr: prValue(origin.pr), author: { id: id(origin.pr.user.id), type: origin.pr.user.type } });
            }
            const account = checkCall(`${request.payload.to.accountType === 'Organization' ? 'organizations' : 'user'}/${id(request.payload.to.accountId)}`);
            if (id(account.id) !== request.payload.to.accountId || account.type !== request.payload.to.accountType) throw new Error('TARGET_ACCOUNT_CHANGED');
            checked.targetLogin = account.login;
        }
        const authorization = operationAuthority({ request, proposal, approvals, context, inputs, adapter, call });
        const ready = checked.operation !== 'OWNERSHIP_TRANSFER' || adapter.invoke({ command: 'transfer-ready',
            request: adapter.archive(state.raw(checked.requestPath), checked.requestPath), authority: authorization.authority, approvals }).ready;
        applied = ready ? applyOperation({ sdk, adapter, state, checked, ...authorization, approvals, appliedAt, nextUpdate })
            : { recordOnly: true, writes: new Map() };
        applied.decision = authorization.reference;
    }
    if (applied.replayed) return applied;
    if (!applied.recordOnly) generateState({ sdk, adapter, state, writes: applied.writes, communityKey, privateBytes: credentials.privateBytes,
        appliedAt, nextUpdate, decision: applied.decision });
    const result = makeReceipt({ requestId, operation: version.checked.operation, pr: selected?.pr, current: context.current, run: context.run,
        writes: applied.writes, state, appliedAt, recordOnly: applied.recordOnly === true, inputFiles: prepared.inputFiles, releases: applied.release ? [applied.release] : [],
        reviewContext: { checked: Object.fromEntries(['operation', 'pr', 'submission', 'submissionPath', 'submissionSha256', 'descriptor', 'package',
            'bindingSha256', 'publisherSha256', 'owner', 'from', 'to', 'requestPath', 'requestId', 'requestSha256', 'recoveryRequired', 'organizationRepresentationRequired']
            .filter(key => version.checked[key] !== undefined).map(key => [key, version.checked[key]])), publicationBindingSha256: version.publicationBindingSha256,
            ...(version.candidate ? { candidate: { inputSha256: version.candidate.inputSha256, evidence: admission.input.evidence,
                scan: { riskReportRef: version.candidate.scan.riskReportRef } }, report: version.report } : {}) } });
    const file = path.join(sdk.workspace, 'publication.json');
    fs.writeFileSync(file, result.bytes, { flag: 'wx' });
    return { ...result, file };
}

export async function storeResult(context, file, bundle, sdk, inputs, { call = api, checkCall = github, readGit, verify = verifyPublicationProof, ...transport } = {}) {
    publicationEnvironment(context, inputs, call);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
    verify(file, bundle, context.current, readGit);
    const bytes = fs.readFileSync(file), receipt = JSON.parse(bytes.toString('utf8'));
    if (receiptExpired(receipt)) throw new Error('APPLY_RESULT_EXPIRED');
    if (receipt.baseSha !== context.current || receipt.runId !== id(context.run.id) || receipt.runAttempt !== context.run.run_attempt
        || inputs.prNumber !== receipt.prNumber || inputs.expectedHeadSha !== receipt.headSha) throw new Error('APPLY_EXECUTION_CHANGED');
    const pr = pull(receipt.prNumber, call);
    const pending = reviewPrerequisite(pr, receipt.headSha, context.current);
    if (pending) return { pending, pr };
    const state = stateReader(sdk, pr.head.sha, checkCall, pr.head.repo.full_name);
    currentAdmission(pr.number, sdk, context, restoreReview(sdk, state, receipt), call, readGit);
    const tag = `operation/${receipt.requestId}/${receipt.runId}-${receipt.runAttempt}`;
    const matches = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error('APPLY_ARCHIVE_CONFLICT');
    const release = matches[0] ?? call(`${prefix}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: context.current,
        name: `${receipt.operation} / ${receipt.requestId}`, draft: true, prerelease: true, body: 'Verified preparation for the original submission PR. Publication requires merge confirmation.' } });
    if (!release.draft || release.target_commitish !== context.current) throw new Error('APPLY_ARCHIVE_CONFLICT');
    await immutableAsset(release.id, file, 'publication.json', { call, ...transport });
    await immutableAsset(release.id, bundle, 'publication-attestation.json', { call, ...transport });
    const pointer = { schemaVersion: 1, releaseId: id(release.id), size: bytes.length, sha256: hash(bytes) };
    await readReceipt(sdk, pointer, context.current, { call, readGit, verify, ...transport });
    // Release 在原 PR 合并后才公开；此处只追加原分支，不另建结果 PR。
    try { return appendReviewCommit(receipt, pointer, call); }
    catch (error) {
        if (!['REVIEW_BRANCH_CREDENTIAL_REQUIRED', 'REVIEW_BRANCH_WRITE_DENIED'].includes(error.message)) throw error;
        return { pending: error.message, pr: pull(receipt.prNumber, call) };
    }
}

export function waitingProjection(pr, code) {
    const messages = {
        MAINTAINER_EDITS_REQUIRED: 'Please enable **Allow edits from maintainers** on this pull request, then ask a maintainer to run Complete community review again. No files or releases were published.',
        REVIEW_OPEN_READY_PR_REQUIRED: 'Mark this pull request ready for review before completing the review.',
        REVIEW_OPERATION_REQUIRED: 'This form completes community submissions and management requests. Maintenance PRs use the existing review checks.',
        REVIEW_BRANCH_CREDENTIAL_REQUIRED: 'The protected workflow needs a credential that can update this exact fork branch. Allow edits from maintainers alone does not grant the workflow token access. Configure COMMUNITY_REVIEW_BRANCH_TOKEN in the release environment, then retry.',
        REVIEW_BRANCH_WRITE_DENIED: 'GitHub denied the update to this fork branch. Check COMMUNITY_REVIEW_BRANCH_TOKEN access, Allow edits from maintainers, branch protection and API limits, then retry. The prepared archive is retained; the request has not been approved for merge.',
        PUBLICATION_REVIEW_REQUIRED: 'Complete the human review and resolve validation or scan findings for this exact head, then run Complete community review again.',
        CANDIDATE_ARCHIVE_PENDING: 'The verified candidate archive is still being prepared. Complete the review after the build, scan and archive finish.',
    };
    if (!messages[code]) throw new Error(code);
    return { number: pr.number, head: pr.head.sha, state: pr.state, merged: pr.merged,
        labels: ['review:pending'], summary: `${code}\n\n${messages[code]}` };
}

main(import.meta.url, async () => {
    const mode = process.argv[2];
    if (!['preflight', 'prepare', 'store', 'finalize', 'notify'].includes(mode) || process.argv.length !== 3) throw new Error('PUBLICATION_COMMAND_INVALID');
    const privateValue = process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    delete process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    if (privateValue && (mode !== 'prepare' || privateValue.length > 21848)) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
    const privateBytes = Buffer.from(privateValue ?? '', 'base64');
    try {
        const context = publicationExecution(mode);
        if (mode === 'notify') { notify(JSON.parse(process.env.COMMUNITY_PROJECTIONS)); return; }
        const sdk = prepareSubmission();
        if (mode === 'finalize') {
            const result = await finalizeReleases(context, sdk);
            const numbers = new Set(result.receipts?.flatMap(receipt => [receipt.prNumber, ...receipt.files.filter(file => file.path.startsWith('audits/'))
                .flatMap(file => JSON.parse(Buffer.from(file.bytes, 'base64')).prEvidence.map(pr => pr.number))]) ?? []);
            notify([...numbers].map(number => appliedProjection(pull(number), list(`${prefix}/pulls/${number}/files`, null), result)));
            return;
        }
        const inputs = inputsFrom(event());
        if (mode === 'store') {
            const result = await storeResult(context, process.env.COMMUNITY_PUBLICATION_FILE, process.env.COMMUNITY_ATTESTATION_BUNDLE, sdk, inputs);
            output({ projections: JSON.stringify(result.pending ? [waitingProjection(result.pr, result.pending)] : []), head: result.head ?? '' });
            return;
        }
        let prepared;
        try { prepared = await preparePublication(context, inputs, sdk); }
        catch (error) {
            if (error.message !== 'CANDIDATE_ARCHIVE_PENDING') throw error;
            prepared = { pending: error.message, selected: { pr: pull(inputs.prNumber) } };
        }
        if (mode === 'prepare' && !prepared.pending && id(prepared.selected.pr.head.repo.id) !== policy.repositoryId
            && process.env.HAS_REVIEW_BRANCH_TOKEN !== 'true') prepared.pending = 'REVIEW_BRANCH_CREDENTIAL_REQUIRED';
        if (prepared.pending) {
            output({ ready: 'false', projections: JSON.stringify([waitingProjection(prepared.selected.pr, prepared.pending)]) }); return;
        }
        if (mode === 'preflight') { output({ ready: prepared.replayed ? 'false' : 'true', projections: '[]' }); return; }
        if (prepared.replayed) { output({ replayed: 'true' }); return; }
        if (!privateBytes.length || privateBytes.length > 16384 || privateBytes.toString('base64') !== privateValue) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
        const communityKey = { keyId: process.env.COMMUNITY_RELEASE_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: process.env.COMMUNITY_RELEASE_PUBLIC_KEY_BASE64,
            state: 'ACTIVE', publisher: 'PixivDownloader Community', trustLabel: 'Community source review', official: false };
        const result = await prepareResult(context, inputs, sdk, prepared, { privateBytes, communityKey });
        output({ manifest: result.file });
    } finally { privateBytes.fill(0); }
});
