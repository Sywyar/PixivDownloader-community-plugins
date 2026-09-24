import fs from 'node:fs';
import { nativeTransferApproval, requireTransferReview } from './transfer-reviews.mjs';
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
import { makeReceipt, receiptPath, receiptExpired, appendReviewCommit, reviewPrerequisite, checkResult, reviewedRequestCall, generatedParents } from './apply-result.mjs';
import { reference, proofPath, saveReceiptFiles, readReceiptFiles } from './receipt-storage.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { finalizeReleases } from './publication-releases.mjs';
import { notify, appliedProjection } from './community-gate.mjs';
import { signedStatusEligible } from './status-authorization.mjs';
import { mergeStatus } from './status-merge.mjs';

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
    if (!context.automatic && context.run.event !== 'workflow_dispatch') throw new Error('PUBLICATION_DISPATCH_REQUIRED');
    if (!context.automatic && !reviewers(call).includes(id(context.run.triggering_actor.id))) throw new Error('PUBLICATION_REVIEWER_REQUIRED');
    const pr = pull(inputs.prNumber, call, context.current);
    if (context.automatic && (pr.state !== 'open' || pr.merged || pr.draft)) return { selected: { pr }, pending: 'REVIEW_OPEN_READY_PR_REQUIRED' };
    const pending = reviewPrerequisite(pr, inputs.expectedHeadSha, context.current);
    if (pending) return { selected: { pr }, pending };
    const files = list(`${prefix}/pulls/${pr.number}/files`, null, call);
    if (files.some(file => /^generated\/receipts\//u.test(file.filename))) {
        const completion = await checkResult(pr.number, sdk, context.current, { call, readGit, refresh: true });
        if (context.automatic && completion.receipt.authorization !== 'SIGNED_OWNER') {
            return { selected: { pr }, pending: 'STATUS_MANUAL_REVIEW_REQUIRED' };
        }
        if (completion.receipt.baseSha !== context.current || receiptExpired(completion.receipt)) {
            if (completion.receipt.operation === 'RENEWAL') throw new Error('RENEWAL_BASE_CHANGED');
            const receipt = { ...completion.receipt, originalPr: { ...completion.receipt.originalPr,
                base: { ...completion.receipt.originalPr.base, sha: context.current } } };
            const refreshed = await preparePublication(context, { ...inputs, expectedHeadSha: receipt.headSha }, sdk,
                { call: reviewedRequestCall(receipt, call), checkCall: reviewedRequestCall(receipt, checkCall), readGit });
            return { ...refreshed, previousHead: pr.head.sha };
        }
        const frozen = { ...restoreReview(sdk, stateReader(sdk, context.current, checkCall), completion.receipt), completion };
        currentAdmission(pr.number, sdk, context, frozen, call, readGit);
        return { selected: { pr }, replayed: true, receipt: completion.receipt };
    }
    const version = await versionContext(pr.number, sdk, context.current, call, readGit, { checkCall });
    if (!version) return { selected: { pr }, pending: 'REVIEW_OPERATION_REQUIRED' };
    if (context.automatic && !signedStatusEligible(version.checked)) return { selected: { pr }, pending: 'STATUS_MANUAL_REVIEW_REQUIRED' };
    const state = version.checked.operation === 'RENEWAL' ? stateReader(sdk, pr.head.sha, checkCall, pr.head.repo.full_name)
        : stateReader(sdk, context.current, checkCall, policy.repository, { pr, files });
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
    version.transferRepresentations = inputs.organizationRepresentations.split(',').map(value => value.trim()).filter(Boolean);
    let admission;
    try { admission = currentAdmission(pr.number, sdk, context, version, call, readGit); }
    catch (error) { if (['PUBLICATION_REVIEW_REQUIRED', 'STATUS_MANUAL_REVIEW_REQUIRED', 'TRANSFER_OWNER_CONFIRMATION_REQUIRED', 'TRANSFER_OWNER_REJECTED'].includes(error.message)) return { selected: { pr }, pending: error.message }; throw error; }
    return { selected: { pr }, state, requestId: identity, inputFiles: files, version, admission, appliedAt };
}
export async function prepareResult(context, inputs, sdk, prepared, credentials, { call = api, checkCall = github, readGit } = {}) {
    publicationEnvironment(context, inputs, call);
    if (prepared.replayed) return { replayed: true, receipt: prepared.receipt };
    const { selected, state, requestId, version, admission, appliedAt } = prepared;
    if (context.automatic && (!signedStatusEligible(version.checked) || admission.result.authorization !== 'SIGNED_OWNER')) {
        throw new Error('STATUS_MANUAL_REVIEW_REQUIRED');
    }
    const adapter = applySdk(sdk);
    if (!adapter.invoke({ command: 'generated-parents', pr: prValue(selected.pr),
        parents: generatedParents({ headSha: selected.pr.head.sha, baseSha: context.current,
            integratedBase: version.checked.operation !== 'RENEWAL', previousHead: prepared.previousHead }) }).verified) {
        throw new Error('REVIEW_PARENT_CHANGED');
    }
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
            const confirmation = requireTransferReview(checked, proposal.pr, call, version.transferRepresentations);
            const approval = nativeTransferApproval(checked, prValue(proposal.pr), confirmation, adapter);
            if (approval) approvals.push(approval);
            const account = checkCall(`${request.payload.to.accountType === 'Organization' ? 'organizations' : 'user'}/${id(request.payload.to.accountId)}`);
            if (id(account.id) !== request.payload.to.accountId || account.type !== request.payload.to.accountType) throw new Error('TARGET_ACCOUNT_CHANGED');
            checked.targetLogin = account.login;
        }
        const authorization = operationAuthority({ request, proposal, approvals, context, inputs, adapter, call });
        const ready = checked.operation !== 'OWNERSHIP_TRANSFER' || adapter.invoke({ command: 'transfer-ready',
            request: adapter.archive(state.raw(checked.requestPath), checked.requestPath), authority: authorization.authority, approvals }).ready;
        if (!ready && checked.singlePr) throw new Error('TRANSFER_OWNER_CONFIRMATION_REQUIRED');
        // 仅已在主线的旧申请保留补齐路径；新申请不能先合并等待另一方。
        applied = ready ? applyOperation({ sdk, adapter, state, checked, ...authorization, approvals, appliedAt, nextUpdate })
            : { recordOnly: true, writes: new Map() };
        applied.decision = authorization.reference;
    }
    if (applied.replayed) return applied;
    if (!applied.recordOnly) generateState({ sdk, adapter, state, writes: applied.writes, communityKey, privateBytes: credentials.privateBytes,
        appliedAt, nextUpdate, decision: applied.decision });
    const result = makeReceipt({ requestId, operation: version.checked.operation, pr: selected?.pr, current: context.current, run: context.run,
        previousHead: prepared.previousHead,
        writes: applied.writes, state, appliedAt, authorization: context.automatic ? 'SIGNED_OWNER' : undefined,
        recordOnly: applied.recordOnly === true, inputFiles: prepared.inputFiles, releases: applied.release ? [applied.release] : [],
        reviewContext: { checked: Object.fromEntries(['operation', 'pr', 'pluginId', 'version', 'submission', 'submissionPath', 'submissionSha256', 'descriptor', 'package',
            'bindingSha256', 'publisherSha256', 'owner', 'from', 'to', 'singlePr', 'ownerConfirmationInRequest', 'requestPath', 'requestId', 'requestSha256', 'reasonCode', 'recoveryRequired', 'organizationRepresentationRequired']
            .filter(key => version.checked[key] !== undefined).map(key => [key, version.checked[key]])), publicationBindingSha256: version.publicationBindingSha256, transferRepresentations: version.transferRepresentations,
            ...(version.candidate ? { candidate: { inputSha256: version.candidate.inputSha256, evidence: admission.input.evidence,
                scan: { riskReportRef: version.candidate.scan.riskReportRef } }, report: version.report } : {}) } });
    const file = path.join(sdk.workspace, 'publication.json');
    fs.writeFileSync(file, result.bytes, { flag: 'wx' });
    saveReceiptFiles(result.value, path.join(sdk.workspace, 'publication-files'));
    return { ...result, file };
}

export async function storeResult(context, file, bundle, sdk, inputs, { call = api, checkCall = github, readGit, verify = verifyPublicationProof } = {}) {
    publicationEnvironment(context, inputs, call);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
    const certificate = verify(file, bundle, context.current, readGit);
    const bytes = fs.readFileSync(file), document = JSON.parse(bytes.toString('utf8'));
    if (document.schemaVersion !== 3) throw new Error('APPLY_RECEIPT_INVALID');
    const receipt = readReceiptFiles(document, path.join(path.dirname(file), 'publication-files'));
    if (receipt.sourceSha !== certificate.sourceRepositoryDigest || receipt.sourceSha !== context.run.sourceSha) throw new Error('APPLY_EXECUTION_CHANGED');
    if (receiptExpired(receipt)) throw new Error('APPLY_RESULT_EXPIRED');
    if (receipt.baseSha !== context.current || receipt.runId !== id(context.run.id) || receipt.runAttempt !== context.run.run_attempt
        || inputs.prNumber !== receipt.prNumber || inputs.expectedHeadSha !== (receipt.previousHead ?? receipt.headSha)) throw new Error('APPLY_EXECUTION_CHANGED');
    const pr = pull(receipt.prNumber, call);
    const pending = reviewPrerequisite(pr, receipt.previousHead ?? receipt.headSha, context.current);
    if (pending) return { pending, pr };
    const state = stateReader(sdk, context.current, checkCall);
    const reviewCall = reviewedRequestCall(receipt, call);
    currentAdmission(pr.number, sdk, context, { ...restoreReview(sdk, state, receipt), completion: { receipt, reviewCall } }, call, readGit);
    const bundleBytes = fs.readFileSync(bundle);
    const pointer = { schemaVersion: 2, manifest: reference(bytes), attestation: reference(bundleBytes) };
    const proofs = new Map([[proofPath(pointer.manifest.sha256), bytes], [proofPath(pointer.attestation.sha256), bundleBytes]]);
    // 审核正文和证明随原 PR 提交；仅安装包等大产物使用 Release。
    try { return await appendReviewCommit(receipt, pointer, call, { proofs }); }
    catch (error) {
        if (!['REVIEW_BRANCH_CREDENTIAL_REQUIRED', 'REVIEW_BRANCH_WRITE_DENIED'].includes(error.message)) throw error;
        return { pending: error.message, pr: pull(receipt.prNumber, call) };
    }
}

export function waitingProjection(pr, code) {
    const messages = {
        TRANSFER_OWNER_CONFIRMATION_REQUIRED: 'The current owner must approve this request on its original pull request. Do not merge an incomplete transfer. Private organization representation requires explicit verification in this workflow.',
        TRANSFER_OWNER_REJECTED: 'The current owner rejected this transfer. Close the unmerged request; no ownership state has changed.',
        MAINTAINER_EDITS_REQUIRED: 'Please enable **Allow edits from maintainers** on this pull request, then retry Apply signed version status for an eligible signed status request, or Complete community review for a human-reviewed request. No files or releases were published.',
        REVIEW_OPEN_READY_PR_REQUIRED: 'Mark this pull request ready for review before completing the review.',
        REVIEW_OPERATION_REQUIRED: 'This form completes community submissions and management requests. Maintenance PRs use the existing review checks.',
        REVIEW_BRANCH_CREDENTIAL_REQUIRED: 'The protected workflow needs a credential that can update this exact fork branch. Allow edits from maintainers alone does not grant the workflow token access. Configure COMMUNITY_REVIEW_BRANCH_TOKEN in community-status, then retry the selected workflow.',
        REVIEW_BRANCH_WRITE_DENIED: 'GitHub denied the update to this fork branch. Check COMMUNITY_REVIEW_BRANCH_TOKEN access, Allow edits from maintainers, branch protection and API limits, then retry. The prepared archive is retained; the request has not been approved for merge.',
        PUBLICATION_REVIEW_REQUIRED: 'Resolve validation, scan findings and review objections for this exact head, then retry the selected workflow. Requests requiring human approval must complete that review first.',
        STATUS_MANUAL_REVIEW_REQUIRED: 'This request requires human review: provide a valid active-key proof as the current personal owner, or use Complete community review for recovery, organization authority or community restrictions.',
        STATUS_CHECKS_PENDING: 'The request is prepared. Checks for the generated head have not all passed; no merge was attempted. Resolve the checks, then retry the selected workflow with the current head.',
        STATUS_MERGE_BLOCKED: 'GitHub branch protection prevented the merge. The prepared request is retained. Resolve the blocking rule, then retry the selected workflow with the current head.',
        STATUS_MERGE_CREDENTIAL_REQUIRED: 'Automatic merging requires COMMUNITY_REVIEW_BRANCH_TOKEN in the community-status environment to represent the repository owner. The existing owner-only merge rule remains enforced.',
        CANDIDATE_ARCHIVE_PENDING: 'No complete verified candidate is visible. Check that candidate archival has finished and the trusted workflow token can read Draft Releases before completing the review.',
    };
    if (!messages[code]) throw new Error(code);
    return { number: pr.number, head: pr.head.sha, state: pr.state, merged: pr.merged,
        labels: ['review:pending'], summary: `${code}\n\n${messages[code]}` };
}

main(import.meta.url, async () => {
    const mode = process.argv[2];
    if (!['preflight', 'prepare', 'store', 'merge', 'finalize', 'finalize-notify', 'notify'].includes(mode) || process.argv.length !== 3) throw new Error('PUBLICATION_COMMAND_INVALID');
    const privateValue = process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    delete process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    if (privateValue && (mode !== 'prepare' || privateValue.length > 21848)) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
    const privateBytes = Buffer.from(privateValue ?? '', 'base64');
    try {
        const context = publicationExecution(mode);
        if (mode === 'notify' || mode === 'finalize-notify') { notify(JSON.parse(process.env.COMMUNITY_PROJECTIONS)); return; }
        const sdk = prepareSubmission();
        if (mode === 'finalize') {
            const result = await finalizeReleases(context, sdk);
            const numbers = new Set(result.receipts?.flatMap(receipt => [receipt.prNumber, ...receipt.files.filter(file => file.path.startsWith('audits/'))
                .flatMap(file => JSON.parse(Buffer.from(file.bytes, 'base64')).prEvidence.map(pr => pr.number))]) ?? []);
            output({ projections: JSON.stringify([...numbers].map(number =>
                appliedProjection(pull(number), list(`${prefix}/pulls/${number}/files`, null), result))) });
            return;
        }
        const inputs = inputsFrom(event());
        if (mode === 'merge') {
            const result = await mergeStatus(context, sdk, inputs.prNumber, process.env.COMMUNITY_STATUS_HEAD, { inputs });
            output({ projections: JSON.stringify(result.pending
                ? [{ ...result.projection, ...waitingProjection(result.pr, result.pending) }]
                : result.projection ? [result.projection] : []) });
            return;
        }
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
        if (mode === 'preflight') { output({ ready: 'true', projections: '[]' }); return; }
        if (prepared.replayed) { output({ head: prepared.selected.pr.head.sha }); return; }
        if (!privateBytes.length || privateBytes.length > 16384 || privateBytes.toString('base64') !== privateValue) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
        const communityKey = { keyId: process.env.COMMUNITY_RELEASE_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: process.env.COMMUNITY_RELEASE_PUBLIC_KEY_BASE64,
            state: 'ACTIVE', publisher: 'PixivDownloader Community', trustLabel: 'Community source review', official: false };
        const result = await prepareResult(context, inputs, sdk, prepared, { privateBytes, communityKey });
        output({ manifest: result.file });
    } finally { privateBytes.fill(0); }
});
