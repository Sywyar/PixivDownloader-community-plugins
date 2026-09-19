import fs from 'node:fs';
import path from 'node:path';
import { root, evidence, hash } from './sdk.mjs';
import { buildPolicy } from './build-sandbox.mjs';
import { fileDifference } from './build-files.mjs';
import { toolJson } from './tool-process.mjs';

// 扫描 SDK、社区适配及前序证据解析共同决定报告；它们变化时仍可复用原构建包。
export function scanInputs(directory = root) {
    return ['tools/sdk-tools.jar', 'tools/CommunityScan.java', 'scripts/build-evidence.mjs',
        'scripts/submission-build.mjs', 'scripts/sdk.mjs', 'scripts/tool-process.mjs', 'scripts/build-files.mjs',
        'scripts/submission-check.mjs', 'scripts/submission-github.mjs']
        .map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(directory, file))) }));
}

export function scanBuild(sdk, build, submission, execution, previous = null) {
    if (Boolean(submission.source.previousReviewedCommit) !== Boolean(previous)
        || previous && previous.scan.sourceCommit !== submission.source.previousReviewedCommit) throw new Error('SOURCE_BASELINE_REQUIRED');
    sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', sdk.classpath, '-d', path.join(sdk.workspace, 'runtime'),
        path.join(root, 'tools/CommunityScan.java')]);
    const input = sdk.save({ execution, current: { artifact: build.artifact, sha256: build.package.sha256,
        sourceCommit: submission.source.commit, compiledClasses: build.compiledClasses }, previous: previous?.scan ?? null });
    const scanned = toolJson(sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', sdk.classpath, 'CommunityScan', sdk.workspace, input]));
    const dependencyLockRef = evidence(sdk.workspace, { sourceCommit: submission.source.commit,
        packageSha256: build.package.sha256, files: build.dependencyFiles, compiledClasses: build.compiledClasses });
    const dependencyReportRef = evidence(sdk.workspace, { model: build.model.dependencies,
        files: build.dependencyFiles, metadata: build.dependencyMetadata });
    const licenseReportRef = evidence(sdk.workspace, { plugin: submission.license,
        dependencyDeclarations: build.dependencyMetadata, compatibility: 'REQUIRES_REVIEW' });
    const sourceDiffRef = evidence(sdk.workspace, { sourceCommit: submission.source.commit,
        previousReviewedCommit: submission.source.previousReviewedCommit, sourceArchive: submission.source.archive,
        ...fileDifference(previous?.sourceFiles ?? [], build.sourceFiles) });
    const basic = JSON.parse(fs.readFileSync(path.join(sdk.workspace, scanned.sbomRef.path), 'utf8'));
    // 缓存包含编译、测试和 provided 依赖；明确记录用途，不能冒充全部随包运行依赖。
    const declarations = new Map(build.dependencyMetadata.map(item => [item.reference.path, item]));
    const sbomRef = evidence(sdk.workspace, { ...basic, components: [...basic.components, ...build.dependencyFiles.map(file => {
        const metadata = declarations.get(file.path);
        const licenses = metadata?.licenses.filter(license => license.name).map(license => ({ license: { name: license.name } })) ?? [];
        return { type: 'file', name: file.path, 'bom-ref': `build/${file.path}`,
            hashes: [{ alg: 'SHA-256', content: file.sha256 }], ...(licenses.length ? { licenses } : {}),
            properties: [{ name: 'pixivdownload:origin', value: 'BUILD_CACHE' },
                { name: 'pixivdownload:size', value: String(file.size) }] };
    })] });
    const toolchain = JSON.parse(fs.readFileSync(path.join(sdk.workspace, 'contracts/community/v1/bundle-manifest.json'), 'utf8')).toolchain;
    const tool = submission.buildProfile.id.split('-')[0];
    const rebuildProofRef = evidence(sdk.workspace, { schemaVersion: 1, sourceCommit: submission.source.commit,
        jdkVersion: build.jdkVersion, buildToolVersion: toolchain[tool].version, buildImageSha256: buildPolicy.image.split('sha256:')[1],
        dependencyLockRef, packageSize: build.package.size, packageSha256: build.package.sha256, sbomRef, result: 'MATCH' });
    return { ...scanned, sbomRef, dependencyReportRef, licenseReportRef, sourceDiffRef, rebuildProofRef, dependencyLockRef };
}
