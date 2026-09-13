import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { prepareSubmission } from '../submission-sdk.mjs';
import { scanBuild } from '../build-evidence.mjs';
import { hash, root } from '../sdk.mjs';

test('固定扫描工具处理实际 class 并绑定包、源码、依赖和重建证据', () => {
    const sdk = prepareSubmission();
    const project = path.join(sdk.workspace, 'plugin');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'Probe.java'), 'public class Probe { static { if (true) throw new Error("must never load"); } '
        + 'public void remove(java.nio.file.Path p) throws Exception { java.nio.file.Files.delete(p); } }');
    sdk.run('javac', ['--release', '17', '-d', project, path.join(project, 'Probe.java')]);
    const compiled = fs.readFileSync(path.join(project, 'Probe.class'));
    fs.writeFileSync(path.join(project, 'plugin.properties'), 'plugin.id=example-minimal\nplugin.version=2.3.4\n'
        + 'plugin.class=Probe\nplugin.description=Example\npixiv.execution-mode=host-process-full-trust\n');
    const artifact = path.join(sdk.workspace, 'plugin.jar');
    sdk.run('jar', ['--create', '--no-manifest', '--file', artifact, '-C', project, '.']);
    const submission = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json'), 'utf8'));
    submission.source.previousReviewedCommit = null;
    const build = { artifact, package: sdk.invoke({ command: 'inspect', file: artifact }), compiledClasses: [
        { path: 'target/classes/Probe.class', size: compiled.length, sha256: hash(compiled) }],
        dependencyFiles: [], dependencyMetadata: [], sourceFiles: [], model: { dependencies: [] }, jdkVersion: '17.0.1+1' };
    const execution = { runId: '123', runAttempt: 1, headSha: 'a'.repeat(40) };
    const result = scanBuild(sdk, build, submission, execution);
    const read = ref => {
        const bytes = fs.readFileSync(path.join(sdk.workspace, ref.path));
        assert.equal(bytes.length, ref.size); assert.equal(hash(bytes), ref.sha256);
        return JSON.parse(bytes);
    };
    const report = read(result.riskReportRef);
    assert.equal(report.packageSha256, build.package.sha256);
    assert.equal(report.headSha, execution.headSha);
    assert.equal(report.status, 'COMPLETE');
    assert.equal(report.observations.length, 1);
    assert.equal(report.observations[0].origin, 'PLUGIN');
    const proof = read(result.rebuildProofRef);
    assert.equal(proof.result, 'MATCH');
    assert.equal(proof.sourceCommit, submission.source.commit);
    assert.deepEqual(proof.sbomRef, result.sbomRef);
    assert.deepEqual(proof.dependencyLockRef, result.dependencyLockRef);
    for (const ref of [result.sbomRef, result.dependencyReportRef, result.licenseReportRef,
        result.sourceDiffRef, result.dependencyLockRef, result.riskDifferenceRef, ...result.evidence]) read(ref);
    assert.throws(() => scanBuild(sdk, build, { ...submission, source: { ...submission.source,
        previousReviewedCommit: 'b'.repeat(40) } }, execution), /SOURCE_BASELINE_REQUIRED/u);
    const unknown = scanBuild(sdk, { ...build, compiledClasses: [] }, submission, execution);
    assert.equal(read(unknown.riskReportRef).observations[0].origin, 'UNKNOWN');
});
