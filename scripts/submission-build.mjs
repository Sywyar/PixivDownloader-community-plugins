import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { main } from './github.mjs';
import { root } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { checkPull } from './submission-pr.mjs';
import { stateReader } from './submission-github.mjs';
import { sourceArchive } from './submission-check.mjs';
import { download } from './download.mjs';
import { event } from './platform.mjs';
import { buildExecution } from './candidate-run.mjs';
import { prepareBuildTools } from './build-tools.mjs';
import { rebuild } from './build.mjs';
import { scanBuild, scanInputs } from './build-evidence.mjs';
import { fileSnapshot } from './build-files.mjs';
import { buildPolicy } from './build-sandbox.mjs';
import { writeCandidate } from './candidate.mjs';
import { buildInputs, reuseBuild } from './build-reuse.mjs';

export async function previousBuild(sdk, checked, state = stateReader(sdk, checked.pr.base), fetch = download) {
    const commit = checked.submission.source.previousReviewedCommit;
    if (!commit) return null;
    const previous = state.published(checked.pluginId).filter(record => record.value.sourceCommit === commit);
    if (previous.length !== 1) throw new Error('PREVIOUS_SOURCE_AMBIGUOUS');
    const published = previous[0].value;
    const review = sdk.document('REVIEW', state.reference(published.reviewRef), published.reviewRef.path).value;
    if (review.source.commit !== commit || review.packageSha256 !== published.package.sha256
        || review.pluginId !== checked.pluginId || review.assuranceLevel !== 'SOURCE_REVIEWED') throw new Error('PREVIOUS_REVIEW_CHANGED');
    const proof = JSON.parse(state.reference(review.rebuildProofRef));
    const lock = JSON.parse(state.reference(proof.dependencyLockRef));
    if (lock.sourceCommit !== commit || lock.packageSha256 !== review.packageSha256
        || !Array.isArray(lock.compiledClasses)) throw new Error('PREVIOUS_BUILD_CHANGED');
    const artifact = path.join(sdk.workspace, 'previous' + (new URL(published.package.url).pathname.endsWith('.jar') ? '.jar' : '.zip'));
    await fetch(published.package.url, artifact, sdk.invoke({ command: 'limits' }).maxArchiveBytes,
        { size: published.package.expectedSize, sha256: published.package.sha256 });
    const source = await sourceArchive(sdk, review.source, review.buildProfile.projectDir);
    return { scan: { artifact, sha256: published.package.sha256, sourceCommit: commit, compiledClasses: lock.compiledClasses },
        sourceFiles: await fileSnapshot(source.sourceRoot, buildPolicy.diskBytes) };
}

main(import.meta.url, async () => {
    if (process.argv.length !== 2) throw new Error('SUBMISSION_BUILD_ARGUMENTS');
    const execution = buildExecution();
    const sdk = prepareSubmission();
    const payload = event();
    const checked = await checkPull(payload.number ?? payload.inputs?.prNumber, sdk);
    if (!['FIRST_RELEASE', 'UPDATE'].includes(checked.operation)) {
        console.log(JSON.stringify({ validation: checked.validation, operation: checked.operation ?? null }));
        return;
    }
    const fixedInputs = buildInputs(sdk, checked);
    const reused = await reuseBuild(sdk, checked, execution.workflowSha, fixedInputs);
    const scanner = scanInputs();
    if (reused && reused.archived.candidate.pr.head === checked.pr.head
        && reused.archived.candidate.submissionSha256 === checked.submissionSha256
        && isDeepStrictEqual(reused.archived.candidate.inputs.scanner, scanner)) {
        const report = JSON.parse(fs.readFileSync(path.join(sdk.workspace, reused.archived.candidate.scan.riskReportRef.path), 'utf8'));
        if (report.status === 'COMPLETE') {
            console.log(JSON.stringify({ state: 'PENDING_REVIEW', reusedReleaseId: reused.archived.releaseId }));
            return;
        }
    }
    let build = reused?.build;
    if (!build) {
        const tools = path.join(sdk.workspace, 'build-tools');
        await prepareBuildTools(sdk, tools);
        build = await rebuild(sdk, checked, tools);
    }
    const previous = await previousBuild(sdk, checked);
    const scan = scanBuild(sdk, build, checked.submission, { ...execution, headSha: checked.pr.head }, previous);
    const inputs = { build: fixedInputs, submissionSha256: checked.submissionSha256, scanner,
        scanReportSha256: scan.riskReportRef.sha256, reusedFrom: build.reusedFrom ?? null };
    const output = path.join(root, 'target/submission-build');
    const candidate = await writeCandidate(sdk, checked, build, scan, inputs, execution, output);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact=community-build-${execution.runId}-${execution.runAttempt}-${candidate.inputSha256}\n`, 'utf8');
    console.log(JSON.stringify({ state: candidate.state, inputSha256: candidate.inputSha256, measurements: candidate.measurements }));
});
