import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { main, prefix, id, list } from './github.mjs';
import { root, hash } from './sdk.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { checkPull } from './submission-pr.mjs';
import { stateReader } from './submission-github.mjs';
import { sourceArchive } from './submission-check.mjs';
import { download } from './download.mjs';
import { event, pull, classify } from './platform.mjs';
import { buildExecution } from './candidate-run.mjs';
import { prepareBuildTools } from './build-tools.mjs';
import { rebuild } from './build.mjs';
import { scanBuild, scanInputs } from './build-evidence.mjs';
import { fileSnapshot } from './build-files.mjs';
import { buildPolicy } from './build-sandbox.mjs';
import { writeCandidate } from './candidate.mjs';
import { buildInputs, reuseBuild } from './build-reuse.mjs';
import { archivedPackage } from './revoked-packages.mjs';
import { downloadCandidate } from './candidate-transfer.mjs';
import { releaseStatus } from './apply-generation.mjs';

function previousPublication(checked, state) {
    const commit = checked.submission.source.previousReviewedCommit;
    if (!commit) return null;
    const previous = state.published(checked.pluginId).filter(record => record.value.sourceCommit === commit);
    if (previous.length !== 1) throw new Error('PREVIOUS_SOURCE_AMBIGUOUS');
    return previous[0].value;
}

export async function prefetchPrevious(sdk, checked, state, directory, { call, fetch = downloadCandidate } = {}) {
    const published = previousPublication(checked, state);
    if (!published || releaseStatus(published, JSON.parse(state.raw('revocations.json'))) !== 'REVOKED') return false;
    const archived = archivedPackage(published, call);
    // 撤销收尾可能尚未迁走公开包，此时构建继续沿用原公开下载。
    if (!archived) return false;
    fs.mkdirSync(directory, { recursive: true });
    await fetch(`${prefix}/releases/assets/${id(archived.asset.id)}`, path.join(directory, 'package'),
        sdk.invoke({ command: 'limits' }).maxArchiveBytes, { size: published.package.expectedSize, sha256: published.package.sha256 });
    return true;
}

export async function previousBuild(sdk, checked, state = stateReader(sdk, checked.pr.base), fetch = download,
    { archivedFile = process.env.COMMUNITY_PREVIOUS_PACKAGE, source = sourceArchive } = {}) {
    const published = previousPublication(checked, state);
    if (!published) return null;
    const commit = checked.submission.source.previousReviewedCommit;
    const review = sdk.document('REVIEW', state.reference(published.reviewRef), published.reviewRef.path).value;
    if (review.source.commit !== commit || review.packageSha256 !== published.package.sha256
        || review.pluginId !== checked.pluginId || review.assuranceLevel !== 'SOURCE_REVIEWED') throw new Error('PREVIOUS_REVIEW_CHANGED');
    const proof = JSON.parse(state.reference(review.rebuildProofRef));
    const lock = JSON.parse(state.reference(proof.dependencyLockRef));
    if (lock.sourceCommit !== commit || lock.packageSha256 !== review.packageSha256
        || !Array.isArray(lock.compiledClasses)) throw new Error('PREVIOUS_BUILD_CHANGED');
    const artifact = path.join(sdk.workspace, 'previous' + (new URL(published.package.url).pathname.endsWith('.jar') ? '.jar' : '.zip'));
    const maximum = sdk.invoke({ command: 'limits' }).maxArchiveBytes;
    if (archivedFile) {
        const stat = fs.lstatSync(archivedFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size !== published.package.expectedSize
            || hash(fs.readFileSync(archivedFile)) !== published.package.sha256) throw new Error('PREVIOUS_PACKAGE_CHANGED');
        fs.copyFileSync(archivedFile, artifact, fs.constants.COPYFILE_EXCL);
    } else await fetch(published.package.url, artifact, maximum, { size: published.package.expectedSize, sha256: published.package.sha256 });
    const sources = await source(sdk, review.source, review.buildProfile.projectDir);
    return { scan: { artifact, sha256: published.package.sha256, sourceCommit: commit, compiledClasses: lock.compiledClasses },
        sourceFiles: await fileSnapshot(sources.sourceRoot, buildPolicy.diskBytes) };
}

main(import.meta.url, async () => {
    const prefetch = process.argv.length === 3 && process.argv[2] === 'previous';
    if (process.argv.length !== 2 && !prefetch) throw new Error('SUBMISSION_BUILD_ARGUMENTS');
    const execution = buildExecution();
    const payload = event();
    const number = payload.number ?? payload.inputs?.prNumber;
    if (prefetch && classify(pull(number), list(`${prefix}/pulls/${id(number)}/files`, null)) !== 'version') return;
    const sdk = prepareSubmission();
    const checked = await checkPull(number, sdk);
    if (!['FIRST_RELEASE', 'UPDATE'].includes(checked.operation)) {
        console.log(JSON.stringify({ validation: checked.validation, operation: checked.operation ?? null }));
        return;
    }
    if (prefetch) {
        if (await prefetchPrevious(sdk, checked, stateReader(sdk, checked.pr.base), path.join(root, 'target/previous-build'))) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact=community-previous-${execution.runId}-${execution.runAttempt}\n`, 'utf8');
        }
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
