import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { root, hash } from './sdk.mjs';
import { buildPolicy } from './build-sandbox.mjs';
import { buildToolchain } from './build-tools.mjs';
import { archivedCandidates, readArchivedCandidate } from './archive-read.mjs';

export function buildInputs(sdk, checked) {
    const toolchain = buildToolchain(sdk);
    const implementation = ['scripts/build-profile.mjs', 'scripts/build.mjs', 'scripts/build-sandbox.mjs',
        'scripts/build-files.mjs', 'scripts/build-tools.mjs', 'scripts/build-proxy.mjs', 'scripts/project.mjs', 'scripts/sdk.mjs',
        'scripts/submission-sdk.mjs', 'scripts/github.mjs', 'scripts/download.mjs',
        'tools/CommunityModel.java', 'tools/CommunitySubmission.java', 'tools/CommunitySource.java', 'tools/community-model.gradle']
        .map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
    return { sourceCommit: checked.submission.source.commit, sourceArchive: checked.submission.source.archive,
        buildProfile: checked.submission.buildProfile, package: checked.package, toolchain, policy: buildPolicy, implementation };
}

export function reusedBuild(sdk, archived, checked, expected) {
    const value = archived.candidate;
    if (!isDeepStrictEqual(value.inputs.build, expected)) return null;
    const file = value.files.find(file => /^plugin\.(?:jar|zip)$/u.test(file.path));
    const artifact = path.join(archived.directory, file.path);
    if (!fs.readFileSync(artifact).equals(fs.readFileSync(checked.packageFile))) throw new Error('REUSED_PACKAGE_CHANGED');
    const dependencies = JSON.parse(fs.readFileSync(path.join(sdk.workspace, value.scan.dependencyReportRef.path), 'utf8'));
    const proof = JSON.parse(fs.readFileSync(path.join(sdk.workspace, value.scan.rebuildProofRef.path), 'utf8'));
    return { artifact, package: checked.package, model: { dependencies: dependencies.model },
        jdkVersion: proof.jdkVersion, dependencyFiles: dependencies.files, dependencyMetadata: dependencies.metadata,
        compiledClasses: value.compiledClasses, sourceFiles: value.sourceFiles, measurements: value.measurements,
        reusedFrom: { releaseId: archived.releaseId, inputSha256: value.inputSha256 } };
}

export async function reuseBuild(sdk, checked, current, expected) {
    for (const release of archivedCandidates(checked.pr.number)) {
        const archived = await readArchivedCandidate(sdk, release, current);
        const build = reusedBuild(sdk, archived, checked, expected);
        if (build) return { build, archived };
    }
    return null;
}
