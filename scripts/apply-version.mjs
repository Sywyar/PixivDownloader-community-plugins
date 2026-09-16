import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash } from './sdk.mjs';
import { catalogId, prValue } from './platform.mjs';
import { publisherPath } from './submission-check.mjs';
import { encoded, formalTag, packageName } from './apply-generation.mjs';
import { archiveAdmission, publicationEnvironment } from './apply-context.mjs';
import { list, prefix } from './github.mjs';

// 其它请求推进主线后，已签发包与审核记录继续沿用；重新生成的只有当前整代状态。
export function rebasePublication(state, adapter, receipt, decision, communityKey) {
    const checked = receipt.reviewContext.checked, submission = checked.submission;
    if (!submission || receipt.releases.length !== 1 || state.published(submission.pluginId).some(row => row.value.version === submission.version)) throw new Error('APPLY_RECOVERY_CHANGED');
    const keyFile = receipt.files.find(file => file.path === 'generated/community-key.json');
    const keyBytes = keyFile ? Buffer.from(keyFile.bytes, 'base64') : state.raw('generated/community-key.json');
    if (!keyBytes || !isDeepStrictEqual(JSON.parse(keyBytes.toString('utf8')), communityKey)) throw new Error('COMMUNITY_KEY_CHANGED');
    if (hash(state.raw(publisherPath(checked.owner))) !== checked.publisherSha256) throw new Error('PUBLISHER_CHANGED');
    const binding = state.raw(`plugin-bindings/${submission.pluginId}.json`);
    if ((binding ? hash(binding) : hash(Buffer.from('null'))) !== checked.bindingSha256) throw new Error('BINDING_CHANGED');
    if ((state.published(submission.pluginId)[0]?.value.sourceCommit ?? null) !== submission.source.previousReviewedCommit) throw new Error('PREVIOUS_SOURCE_CHANGED');
    const writes = new Map();
    for (const file of receipt.files.filter(file => /^(?:published|reviews|records|plugin-bindings)\//u.test(file.path))) {
        const bytes = Buffer.from(file.bytes, 'base64'), current = state.raw(file.path);
        if (bytes.length !== file.size || hash(bytes) !== file.sha256 || current && !current.equals(bytes)) throw new Error('APPLY_RECOVERY_CHANGED');
        adapter.archive(bytes, file.path); writes.set(file.path, bytes);
    }
    const publication = `published/${submission.pluginId}/${submission.version}.json`;
    if (!writes.has(publication)) throw new Error('APPLY_RECOVERY_CHANGED');
    return { writes, release: receipt.releases[0], decision };
}

export function publishVersion({ sdk, adapter, state, version, pr, context, admission, inputs, communityKey, privateBytes, appliedAt, call }) {
    const checked = version.checked, submission = checked.submission;
    const before = state.published(submission.pluginId).find(record => record.value.version === submission.version);
    if (before) {
        if (before.value.package.sha256 !== checked.package.sha256) throw new Error('VERSION_DIGEST_CONFLICT');
        return { replayed: true, writes: new Map(), published: before.value };
    }
    const bindingPath = `plugin-bindings/${submission.pluginId}.json`;
    const existingBinding = state.read(bindingPath, 'BINDING');
    const bindingBytes = existingBinding?.bytes ?? encoded({ schemaVersion: 1, pluginId: submission.pluginId, owner: checked.owner,
        effectiveRequestId: null, updatedAt: appliedAt });
    sdk.document('BINDING', bindingBytes, bindingPath);
    const binding = adapter.archive(bindingBytes);
    const submissionRef = adapter.archive(state.raw(checked.submissionPath));
    if (submissionRef.sha256 !== checked.submissionSha256) throw new Error('SUBMISSION_CHANGED');
    const publisher = state.read(publisherPath(checked.owner), 'PUBLISHER');
    if (!publisher || publisher.sha256 !== checked.publisherSha256) throw new Error('PUBLISHER_CHANGED');
    const publisherRef = adapter.archive(publisher.bytes);
    archiveAdmission(adapter, sdk, admission.input);
    const approval = adapter.archive(publicationEnvironment(context, inputs, call));
    const p = submission.pluginId, v = submission.version, scan = version.candidate.scan;
    const review = { schemaVersion: 1, owner: checked.owner, ownerLoginSnapshot: publisher.value.githubAccount.loginAtRegistration,
        pluginId: p, version: v, packageSize: checked.package.size, packageSha256: checked.package.sha256, submissionRef,
        source: submission.source, buildProfile: submission.buildProfile, descriptor: checked.descriptor,
        riskScan: { status: version.report.status, scannerVersion: version.report.scannerVersion, rulesSha256: version.report.rulesSha256,
            runId: version.report.runId, runAttempt: version.report.runAttempt, reportRef: scan.riskReportRef,
            decisionRefs: admission.result.decisionRefs, gate: 'PASS' },
        sourceDiffRef: scan.sourceDiffRef, sbomRef: scan.sbomRef, dependencyReportRef: scan.dependencyReportRef,
        licenseReportRef: scan.licenseReportRef, rebuildProofRef: scan.rebuildProofRef, pr: prValue(pr), humanReview: admission.result.human.approval,
        publicationApprovalRef: approval, reviewedAt: appliedAt, assuranceLevel: 'SOURCE_REVIEWED' };
    const reviewPath = `reviews/${p}/${v}.json`, reviewBytes = encoded(review);
    sdk.document('REVIEW', reviewBytes, reviewPath);
    const reviewRef = adapter.archive(reviewBytes);
    const signature = adapter.invoke({ command: 'sign', kind: 'package', communityKey, repositoryId: catalogId, pluginId: p, version: v,
        size: checked.package.size, sha256: checked.package.sha256, sourceCommit: submission.source.commit, reviewSha256: reviewRef.sha256 }, privateBytes);
    if (admission.result.snapshot.bindingSha256 !== binding.sha256) throw new Error('PUBLICATION_BINDING_CHANGED');
    const facts = { owner: checked.owner, descriptor: checked.descriptor, pr: prValue(pr), admission: admission.result,
        rebuildProof: JSON.parse(fs.readFileSync(path.join(sdk.workspace, scan.rebuildProofRef.path), 'utf8')), publicationApprovalRef: approval };
    const candidates = version.candidate.files.filter(file => /^plugin\.(?:jar|zip)$/u.test(file.path));
    if (candidates.length !== 1) throw new Error('FROZEN_PACKAGE_MISSING');
    const frozenPackage = path.join(adapter.workspace, candidates[0].path);
    fs.copyFileSync(path.join(version.directory, candidates[0].path), frozenPackage, fs.constants.COPYFILE_EXCL);
    const bytes = fs.readFileSync(frozenPackage);
    if (bytes.length !== checked.package.size || hash(bytes) !== checked.package.sha256) throw new Error('FROZEN_PACKAGE_CHANGED');
    const previous = state.published(p)[0];
    const result = adapter.invoke({ command: 'publication', communityKey, repositoryId: catalogId, appliedAt, facts,
        submission: submissionRef, review: reviewRef, binding, publisher: publisherRef, signature,
        packageFile: path.basename(frozenPackage), previousVersion: previous ? adapter.archive(previous.bytes) : null });
    const publishedBytes = Buffer.from(result.bytes, 'base64');
    const published = sdk.document('PUBLISHED', publishedBytes, `published/${p}/${v}.json`).value;
    const writes = new Map([[bindingPath, bindingBytes], [reviewPath, reviewBytes], [`published/${p}/${v}.json`, publishedBytes]]);
    for (const [file] of adapter.records) writes.set(file, fs.readFileSync(path.join(adapter.workspace, file)));
    return { replayed: false, writes, published, decision: approval, release: { id: version.releaseId, tag: formalTag(published),
        name: `${published.owner.publisherId} / ${p}-v${v}`, originalTag: `candidate/pr-${pr.number}/${pr.head.sha}/${version.candidate.inputSha256}`,
        targetCommit: context.current, packageName: packageName(published), packageSize: published.package.expectedSize,
        packageSha256: published.package.sha256, reviewBytes: reviewBytes.toString('base64'), signature,
        owner: published.owner, pluginId: p, version: v, sourceCommit: published.sourceCommit,
        originalAssets: list(`${prefix}/releases/${version.releaseId}/assets`, null, call).map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state })) } };
}
