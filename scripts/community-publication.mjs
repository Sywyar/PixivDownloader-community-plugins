import fs from 'node:fs';
import path from 'node:path';
import { api, id, sha, list, prefix, policy, main, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { event, prValue, reviewers, protectedSource, pull } from './platform.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { stateReader, github } from './submission-github.mjs';
import { versionContext } from './version-review.mjs';
import { applySdk } from './apply-sdk.mjs';
import { applyOperation } from './apply-operations.mjs';
import { publishVersion, rebasePublication } from './apply-version.mjs';
import { generateState, encoded, refreshIdentity } from './apply-generation.mjs';
import { publicationExecution, publicationEnvironment, mergedRequest, introducedBy, operationAuthority, currentAdmission, archiveAdmission, restoreReview } from './apply-context.mjs';
import { makeReceipt, receiptPath, receiptExpired, readReceipt, immutableAsset, createResultPull } from './apply-result.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { promoteReleases, finalizeReleases } from './publication-releases.mjs';
import { notify, appliedProjection } from './community-gate.mjs';

const output = value => {
    for (const [key, item] of Object.entries(value)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${item}\n`, 'utf8');
};
export const inputsFrom = payload => {
    const value = payload.inputs ?? {};
    const action = value.action ?? 'apply';
    if (!['apply', 'refresh'].includes(action)) throw new Error('PUBLICATION_ACTION_INVALID');
    if (![undefined, false, true, 'false', 'true'].includes(value.recoveryApproved)) throw new Error('PUBLICATION_INPUT_INVALID');
    if (action === 'refresh' && (value.prNumber || value.expectedHeadSha || value.organizationRepresentations || value.recoveryApproved === true || value.recoveryApproved === 'true')) throw new Error('PUBLICATION_INPUT_INVALID');
    return { action, ...(action === 'apply' ? { prNumber: Number(id(value.prNumber)), expectedHeadSha: sha(value.expectedHeadSha) } : {}),
        recoveryApproved: value.recoveryApproved === true || value.recoveryApproved === 'true',
        organizationRepresentations: value.organizationRepresentations ?? '' };
};

export async function preparePublication(context, inputs, sdk, { call = api, checkCall = github, readGit } = {}) {
    if (context.run.event !== 'workflow_dispatch') throw new Error('PUBLICATION_DISPATCH_REQUIRED');
    if (!reviewers(call).includes(id(context.run.triggering_actor.id))) throw new Error('PUBLICATION_REVIEWER_REQUIRED');
    const refresh = inputs.action === 'refresh';
    const selected = refresh ? null : mergedRequest(inputs.prNumber, context.current, call, readGit);
    if (selected && selected.pr.head.sha !== inputs.expectedHeadSha) throw new Error('PUBLICATION_HEAD_CHANGED');
    const state = stateReader(sdk, context.current, checkCall);
    const files = selected ? list(`${prefix}/pulls/${selected.pr.number}/files`, null, call) : [];
    // 重放必须先读取已执行结果，不能先用已经改变的 owner/key 去重新解释原请求。
    const operationFiles = files.filter(file => /^(?:key-rotations|version-status-requests)\//u.test(file.filename)
        || /^ownership-transfers\/[^/]+\/[a-f0-9]{64}\//u.test(file.filename));
    const requestId = operationFiles[0]?.filename.match(/[a-f0-9]{64}/u)?.[0];
    const submissionFile = files.find(file => file.filename.startsWith('submissions/'));
    const identity = refresh ? refreshIdentity(state) : requestId ?? (submissionFile ? hash(state.raw(submissionFile.filename)) : null);
    if (!identity) throw new Error('PUBLICATION_OPERATION_REQUIRED');
    const stored = state.raw(receiptPath(identity));
    if (stored) {
        const receipt = await readReceipt(sdk, JSON.parse(stored.toString('utf8')), context.current, { call, readGit });
        return { selected, state, requestId: identity, replayed: true, receipt };
    }
    const archives = list(`${prefix}/releases`, null, call).filter(release => release.draft && release.tag_name.startsWith(`operation/${identity}/`));
    for (const release of archives.reverse()) {
        const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
        const manifest = assets.filter(asset => asset.name === 'publication.json');
        if (!assets.some(asset => asset.name === 'publication-attestation.json')) continue;
        if (manifest.length !== 1) throw new Error('APPLY_ARCHIVE_CONFLICT');
        const pointer = { schemaVersion: 1, releaseId: id(release.id), size: manifest[0].size, sha256: manifest[0].digest?.slice(7) };
        const receipt = await readReceipt(sdk, pointer, context.current, { call, readGit });
        if (receipt.requestId !== identity || (refresh ? receipt.operation !== 'REFRESH' || receipt.prNumber !== null
            : receipt.prNumber !== selected.pr.number || receipt.headSha !== selected.pr.head.sha || receipt.mergeSha !== selected.pr.merge_commit_sha)) throw new Error('APPLY_RECOVERY_CHANGED');
        const stale = receipt.baseSha !== context.current || receiptExpired(receipt);
        if (refresh) {
            if (stale) continue;
            return { selected, state, requestId: identity, recovered: true, receipt, pointer };
        }
        if (stale && !receipt.reviewContext.checked.submission) continue;
        if (stale) protectedSource(receipt.baseSha, context.current, readGit);
        const frozen = restoreReview(sdk, state, receipt);
        const admission = currentAdmission(inputs.prNumber, sdk, context, frozen, call, readGit);
        if (stale) return { selected, state, requestId: identity, rebase: receipt, version: frozen,
            admission, appliedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') };
        return { selected, state, requestId: identity, recovered: true, receipt, pointer, admission };
    }
    if (refresh) return { state, requestId: identity, refresh: true, version: { checked: { operation: 'REFRESH' } },
        appliedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') };
    const version = await versionContext(inputs.prNumber, sdk, context.current, call, readGit, { appliedBase: context.current, checkCall });
    const appliedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    if (version.checked.submission) {
        const bindingPath = `plugin-bindings/${version.checked.submission.pluginId}.json`;
        const bindingBytes = state.raw(bindingPath) ?? encoded({ schemaVersion: 1, pluginId: version.checked.submission.pluginId,
            owner: version.checked.owner, effectiveRequestId: null, updatedAt: appliedAt });
        sdk.document('BINDING', bindingBytes, bindingPath);
        version.publicationBindingSha256 = hash(bindingBytes);
    }
    const admission = currentAdmission(inputs.prNumber, sdk, context, version, call, readGit);
    return { selected, state, requestId: identity, version, admission, appliedAt };
}

export async function prepareResult(context, inputs, sdk, prepared, credentials, { call = api, checkCall = github, readGit } = {}) {
    publicationEnvironment(context, inputs, call);
    if (prepared.replayed) return { replayed: true, receipt: prepared.receipt };
    if (prepared.recovered) return { recovered: true };
    const { selected, state, requestId, version, admission, appliedAt } = prepared;
    const adapter = applySdk(sdk);
    if (admission) archiveAdmission(adapter, sdk, admission.input);
    const communityKey = credentials.communityKey;
    const nextUpdate = new Date(Date.parse(appliedAt) + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
    let applied;
    if (prepared.refresh) applied = { writes: new Map(), decision: adapter.archive(publicationEnvironment(context, inputs, call)) };
    else if (prepared.rebase) applied = rebasePublication(state, adapter, prepared.rebase, adapter.archive(publicationEnvironment(context, inputs, call)), communityKey);
    else if (version.checked.submission) applied = publishVersion({ sdk, adapter, state, version, pr: selected.pr, context,
        admission, inputs, communityKey, privateBytes: credentials.privateBytes, appliedAt, call });
    else {
        const checked = version.checked;
        const request = state.read(checked.requestPath, checked.operation === 'KEY_ROTATION' ? 'ROTATION'
            : checked.operation === 'OWNERSHIP_TRANSFER' ? 'TRANSFER' : 'STATUS_REQUEST').value;
        const proposal = introducedBy(checked.requestPath, context.current, call, readGit);
        const approvals = [];
        if (checked.operation === 'OWNERSHIP_TRANSFER') {
            const directory = `ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/`;
            for (const file of state.tree.keys()) if (file.startsWith(directory) && file.endsWith('.json')) {
                const record = state.read(file, 'APPROVAL');
                const native = introducedBy(file, context.current, call, readGit);
                approvals.push({ reference: adapter.archive(record.bytes, file), role: record.value.role,
                    pr: prValue(native.pr), author: { id: id(native.pr.user.id), type: native.pr.user.type } });
            }
            const account = checkCall(`${request.payload.to.accountType === 'Organization' ? 'organizations' : 'user'}/${id(request.payload.to.accountId)}`);
            if (id(account.id) !== request.payload.to.accountId || account.type !== request.payload.to.accountType) throw new Error('TARGET_ACCOUNT_CHANGED');
            checked.targetLogin = account.login;
        }
        const authorization = operationAuthority({ request, proposal, approvals, context, inputs, adapter, call });
        applied = applyOperation({ sdk, adapter, state, checked, ...authorization, approvals, appliedAt, nextUpdate });
        applied.decision = authorization.reference;
    }
    if (applied.replayed) return applied;
    generateState({ sdk, adapter, state, writes: applied.writes, communityKey, privateBytes: credentials.privateBytes,
        appliedAt, nextUpdate, decision: applied.decision });
    const result = makeReceipt({ requestId, operation: version.checked.operation, pr: selected?.pr, current: context.current, run: context.run,
        writes: applied.writes, state, appliedAt, releases: applied.release ? [applied.release] : [],
        reviewContext: { checked: Object.fromEntries(['operation', 'pr', 'submission', 'submissionSha256', 'descriptor', 'package',
            'bindingSha256', 'publisherSha256', 'owner', 'from', 'to', 'requestSha256', 'recoveryRequired', 'organizationRepresentationRequired']
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
    if (receipt.baseSha !== context.current || receipt.runId !== id(context.run.id) || receipt.runAttempt !== context.run.run_attempt) throw new Error('APPLY_EXECUTION_CHANGED');
    const state = stateReader(sdk, context.current, checkCall);
    if (receipt.operation === 'REFRESH') {
        if (inputs.action !== 'refresh' || receipt.requestId !== refreshIdentity(state)) throw new Error('APPLY_RECOVERY_CHANGED');
    } else {
        const selected = mergedRequest(receipt.prNumber, context.current, call, readGit);
        if (inputs.prNumber !== receipt.prNumber || inputs.expectedHeadSha !== receipt.headSha
            || selected.pr.head.sha !== receipt.headSha || selected.pr.merge_commit_sha !== receipt.mergeSha) throw new Error('PUBLICATION_HEAD_CHANGED');
        currentAdmission(receipt.prNumber, sdk, context, restoreReview(sdk, state, receipt), call, readGit);
    }
    const tag = `operation/${receipt.requestId}/${receipt.runId}-${receipt.runAttempt}`;
    const matches = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error('APPLY_ARCHIVE_CONFLICT');
    const release = matches[0] ?? call(`${prefix}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: context.current,
        name: `${receipt.operation} / ${receipt.requestId}`, draft: true, prerelease: true, body: 'Verified result awaiting atomic state application.' } });
    if (!release.draft || release.target_commitish !== context.current) throw new Error('APPLY_ARCHIVE_CONFLICT');
    await immutableAsset(release.id, file, 'publication.json', { call, ...transport });
    await immutableAsset(release.id, bundle, 'publication-attestation.json', { call, ...transport });
    const pointer = { schemaVersion: 1, releaseId: id(release.id), size: bytes.length, sha256: hash(bytes) };
    await readReceipt(sdk, pointer, context.current, { call, readGit, verify, ...transport });
    await promoteReleases(receipt, sdk.workspace, { call, ...transport });
    return createResultPull(receipt, pointer, call);
}

export function failedPublication(context, inputs, call = api, readGit) {
    if (context.run.event !== 'workflow_dispatch' || !reviewers(call).includes(id(context.run.triggering_actor.id))) throw new Error('PUBLICATION_REVIEWER_REQUIRED');
    if (inputs.action === 'refresh') return [];
    const { pr } = mergedRequest(inputs.prNumber, context.current, call, readGit);
    if (pr.head.sha !== inputs.expectedHeadSha) throw new Error('PUBLICATION_HEAD_CHANGED');
    return [{ number: pr.number, head: pr.head.sha, state: pr.state, merged: true, labels: ['state:apply-failed'],
        summary: `Protected application failed. Inspect https://github.com/${policy.repository}/actions/runs/${id(context.run.id)} before retrying. Existing admission checks and published bytes are preserved.` }];
}

main(import.meta.url, async () => {
    const mode = process.argv[2];
    if (!['preflight', 'prepare', 'store', 'recover', 'finalize', 'failed'].includes(mode) || process.argv.length !== 3) throw new Error('PUBLICATION_COMMAND_INVALID');
    const privateValue = process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    delete process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    if (privateValue && (mode !== 'prepare' || privateValue.length > 21848)) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
    const privateBytes = Buffer.from(privateValue ?? '', 'base64');
    try {
        const context = publicationExecution();
        if (mode === 'failed') { notify(failedPublication(context, inputsFrom(event()))); return; }
        const sdk = prepareSubmission();
        if (mode === 'finalize') {
            const result = await finalizeReleases(context, sdk);
            if (!result.applied) return;
            const numbers = new Set();
            for (const receipt of result.receipts) {
                if (receipt.prNumber) numbers.add(receipt.prNumber);
                numbers.add(introducedBy(receiptPath(receipt.requestId), context.current).pr.number);
                for (const file of receipt.files.filter(file => file.path.startsWith('audits/'))) {
                    for (const pr of JSON.parse(Buffer.from(file.bytes, 'base64')).prEvidence) numbers.add(pr.number);
                }
            }
            notify([...numbers].map(number => appliedProjection(pull(number), list(`${prefix}/pulls/${number}/files`, null), result)));
            return;
        }
        if (mode === 'store') {
            const pr = await storeResult(context, process.env.COMMUNITY_PUBLICATION_FILE, process.env.COMMUNITY_ATTESTATION_BUNDLE, sdk, inputsFrom(event()));
            output({ pull: pr.html_url }); return;
        }
        const inputs = inputsFrom(event());
        const prepared = await preparePublication(context, inputs, sdk);
        if (mode === 'preflight') {
            output({ request: prepared.requestId, operation: prepared.version?.checked.operation ?? prepared.receipt.operation }); return;
        }
        if (mode === 'recover') {
            publicationEnvironment(context, inputs);
            if (!prepared.recovered) throw new Error('PUBLICATION_RECOVERY_REQUIRED');
            await promoteReleases(prepared.receipt, sdk.workspace);
            output({ pull: createResultPull(prepared.receipt, prepared.pointer).html_url }); return;
        }
        if (!privateBytes.length || privateBytes.length > 16384 || privateBytes.toString('base64') !== privateValue) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
        const communityKey = { keyId: process.env.COMMUNITY_RELEASE_KEY_ID, algorithm: 'Ed25519', publicKeySpkiBase64: process.env.COMMUNITY_RELEASE_PUBLIC_KEY_BASE64,
            state: 'ACTIVE', publisher: 'PixivDownloader Community', trustLabel: 'Community source review', official: false };
        const result = await prepareResult(context, inputs, sdk, prepared, { privateBytes, communityKey });
        if (result.replayed) output({ replayed: 'true' });
        else if (result.recovered) output({ recovered: 'true' });
        else output({ manifest: result.file });
    } finally { privateBytes.fill(0); }
});
