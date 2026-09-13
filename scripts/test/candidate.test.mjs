import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { prepareSubmission } from '../submission-sdk.mjs';
import { root, hash, evidence } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { buildPath, writeCandidate, candidateIdentity } from '../candidate.mjs';
import { verifyBuildRun } from '../candidate-run.mjs';
import { unpackCandidate } from '../candidate-transfer.mjs';
import { archiveCandidate } from '../archive.mjs';
import { archiveCertificate, storeArchiveProof, verifyArchiveProof } from '../archive-proof.mjs';
import { readArchivedCandidate } from '../archive-read.mjs';
import { buildInputs, reusedBuild } from '../build-reuse.mjs';
import { scanInputs } from '../build-evidence.mjs';
import { archivePath } from '../candidate.mjs';

test('真实交接 ZIP 保留精确字节；Draft 归档重复和中断恢复不覆盖资产', async () => {
    const sdk = prepareSubmission();
    const submission = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json'), 'utf8'));
    const source = path.join(sdk.workspace, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'plugin.properties'), 'plugin.id=example-minimal\nplugin.version=2.3.4\nplugin.class=example.Plugin\n');
    const artifact = path.join(sdk.workspace, 'plugin.jar');
    const sourceArchive = path.join(sdk.workspace, 'source.zip');
    sdk.run('jar', ['--create', '--no-manifest', '--file', artifact, '-C', source, '.']);
    fs.copyFileSync(artifact, sourceArchive);
    const bytes = fs.readFileSync(artifact);
    submission.source.archive.size = bytes.length;
    submission.source.archive.sha256 = hash(bytes);
    const checked = { validation: 'STATIC_VALIDATED', submission, submissionPath: 'submissions/101/example-minimal/2.3.4.json',
        submissionSha256: hash(Buffer.from(JSON.stringify(submission))), sourceArchive, sourceRepositoryId: '456', packageFile: artifact,
        owner: { accountId: '101', accountType: 'User', publisherId: submission.publisherId },
        package: { size: bytes.length, sha256: hash(bytes) }, descriptor: {}, publisherKeyFingerprint: 'f'.repeat(64),
        pr: { number: 17, head: 'a'.repeat(40), base: 'b'.repeat(40), headId: '123' } };
    const execution = { workflowSha: 'b'.repeat(40), runId: '301', runAttempt: 1 };
    const report = evidence(sdk.workspace, { finding: 'exact bytecode call' });
    const scan = { report, dependencyReportRef: evidence(sdk.workspace, { model: [], files: [], metadata: [] }),
        rebuildProofRef: evidence(sdk.workspace, { jdkVersion: 'test-jdk' }) };
    const inputs = buildInputs(sdk, checked);
    const output = path.join(sdk.workspace, 'handoff');
    const candidate = await writeCandidate(sdk, checked, { artifact, measurements: {}, compiledClasses: [], sourceFiles: [] },
        scan, { build: inputs, submissionSha256: checked.submissionSha256 }, execution, output);
    const zip = path.join(sdk.workspace, 'handoff.zip');
    sdk.run('jar', ['--create', '--no-manifest', '--file', zip, '-C', output, '.']);
    const restored = unpackCandidate(sdk, zip);
    assert.deepEqual(restored.candidate, candidate);
    assert.deepEqual(fs.readFileSync(path.join(restored.directory, 'plugin.jar')), bytes);
    const run = { id: 301, run_attempt: 1, event: 'pull_request_target', status: 'completed', conclusion: 'success',
        path: buildPath, repository: { id: policy.repositoryId }, head_repository: { id: policy.repositoryId }, workflow_id: 501 };
    const pull = { number: 17, state: 'open', user: { type: 'User', id: 101 },
        head: { sha: checked.pr.head, repo: { id: checked.pr.headId } }, base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    const marker = { repositoryId: policy.repositoryId, repositoryOwnerId: policy.repositoryOwnerId, workflowPath: buildPath,
        ...execution, prNumber: 17, headSha: checked.pr.head };
    let release = null, creates = 0, uploads = 0;
    const assets = [];
    const stored = new Map();
    const call = (endpoint, options = {}) => {
        if (endpoint.endsWith('/attempts/1')) return run;
        if (endpoint.endsWith('/workflows/501')) return { id: 501, path: buildPath };
        if (endpoint.endsWith('/pulls/17')) return pull;
        if (endpoint.includes('/attempts/1/jobs')) return [{ total_count: 1, jobs: [{ id: 601, run_id: 301,
            name: 'Build and scan version', conclusion: 'success', steps: [{ name: 'Bind protected build execution', conclusion: 'success' }] }] }];
        if (endpoint.endsWith('/jobs/601/logs')) return Buffer.from(`2026-01-01T00:00:00Z COMMUNITY_BUILD_EXECUTION ${JSON.stringify(marker)}\n`);
        if (endpoint === `${prefix}/releases` && options.method === 'POST') {
            creates++; assert.equal(options.body.draft, true); assert.equal(options.body.target_commitish, execution.workflowSha);
            release = { ...options.body, id: 701, published_at: null, html_url: 'https://github.com/example/draft' }; return release;
        }
        if (endpoint.includes('/releases?')) return [release ? [release] : []];
        if (endpoint.includes('/releases/701/assets?')) return [assets];
        if (endpoint.endsWith('/releases/701')) return release;
        throw new Error('UNEXPECTED_REQUEST: ' + endpoint);
    };
    const readGit = args => args[0] === 'merge-base' ? '' : 'same-protected-object';
    const options = { call, readGit, check: async () => checked,
        upload: (_id, file, name) => {
            uploads++; const bytes = fs.readFileSync(file);
            const asset = { id: 800 + uploads, name, state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) };
            assets.push(asset); stored.set(String(asset.id), bytes); return asset;
        }, download: async (endpoint, file, maximum, expected) => {
            const bytes = stored.get(endpoint.split('/').at(-1));
            assert.ok(bytes.length <= maximum); assert.equal(bytes.length, expected.size); assert.equal(hash(bytes), expected.sha256);
            fs.writeFileSync(file, bytes, { flag: 'wx' });
        } };
    const archive = () => archiveCandidate(sdk, candidate, restored.directory, execution.workflowSha, options);
    assert.equal((await archive()).state, 'PENDING_REVIEW');
    assert.equal(creates, 1); assert.equal(uploads, 4);
    assert.ok(assets.some(asset => asset.name.startsWith(`pixivdownload-plugin-${checked.owner.publisherId}-`)));
    await archive(); assert.equal(creates, 1); assert.equal(uploads, 4);
    assets.pop(); await archive(); assert.equal(uploads, 5);
    const manifest = path.join(restored.directory, 'candidate.json');
    const bundle = path.join(sdk.workspace, 'test-bundle.json');
    fs.writeFileSync(bundle, '{}');
    // 此处只验证归档与字节复用；密码学验证另由真实 gh attestation 入口执行。
    const verifiedOptions = { ...options, verify: () => ({ sourceRepositoryDigest: execution.workflowSha }) };
    await storeArchiveProof(701, manifest, bundle, execution.workflowSha, verifiedOptions);
    await storeArchiveProof(701, manifest, bundle, execution.workflowSha, verifiedOptions);
    assert.equal(uploads, 6);
    const archived = await readArchivedCandidate(sdk, release, execution.workflowSha, verifiedOptions);
    const reused = reusedBuild(sdk, archived, checked, inputs);
    assert.deepEqual(fs.readFileSync(reused.artifact), bytes);
    assert.equal(reused.reusedFrom.releaseId, '701');
    const scannerDirectory = path.join(sdk.workspace, 'scanner-inputs');
    const scanner = scanInputs();
    for (const file of scanner) {
        const destination = path.join(scannerDirectory, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, file.path), destination);
    }
    assert.deepEqual(scanInputs(scannerDirectory), scanner);
    for (const file of scanner) {
        const destination = path.join(scannerDirectory, file.path);
        const original = fs.readFileSync(destination);
        fs.appendFileSync(destination, '\nchanged scan implementation');
        assert.notDeepEqual(scanInputs(scannerDirectory), scanner, file.path);
        assert.deepEqual(fs.readFileSync(reusedBuild(sdk, archived, checked, inputs).artifact), bytes);
        fs.writeFileSync(destination, original);
    }
    fs.writeFileSync(path.join(scannerDirectory, 'README.md'), 'Documentation only', 'utf8');
    assert.deepEqual(scanInputs(scannerDirectory), scanner);
    assert.equal(reusedBuild(sdk, archived, checked, { ...inputs, sourceCommit: '8'.repeat(40) }), null);
    const manifestFile = path.join(sdk.workspace, 'contracts/community/v1/bundle-manifest.json');
    const sdkManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    sdkManifest.toolchain.sdk += '-scanner-update';
    sdkManifest.toolchain.jsonSchemaValidator += '-scanner-update';
    fs.writeFileSync(manifestFile, JSON.stringify(sdkManifest), 'utf8');
    assert.deepEqual(fs.readFileSync(reusedBuild(sdk, archived, checked, buildInputs(sdk, checked)).artifact), bytes);
    for (const tool of ['maven', 'gradle', 'sbt']) {
        const digest = sdkManifest.toolchain[tool].sha256;
        sdkManifest.toolchain[tool].sha256 = hash(Buffer.from(digest));
        fs.writeFileSync(manifestFile, JSON.stringify(sdkManifest), 'utf8');
        assert.equal(reusedBuild(sdk, archived, checked, buildInputs(sdk, checked)), null);
        sdkManifest.toolchain[tool].sha256 = digest;
    }
    fs.appendFileSync(reused.artifact, 'changed');
    assert.throws(() => reusedBuild(sdk, archived, checked, inputs), /REUSED_PACKAGE_CHANGED/u);
    assets[0].digest = 'sha256:' + '0'.repeat(64);
    await assert.rejects(archive(), /CANDIDATE_ASSET_CONFLICT/u); assert.equal(uploads, 6);
    release.draft = false;
    await assert.rejects(archive(), /CANDIDATE_ALREADY_PUBLISHED/u);
    await assert.rejects(storeArchiveProof(701, manifest, bundle, execution.workflowSha, verifiedOptions), /CANDIDATE_RELEASE_CHANGED/u);
    for (const [key, value] of [['event', 'pull_request'], ['conclusion', 'failure'], ['run_attempt', 2]]) {
        const previous = run[key]; run[key] = value;
        assert.throws(() => verifyBuildRun(candidate, execution.workflowSha, call, readGit), /BUILD_RUN_INVALID/u); run[key] = previous;
    }
    marker.workflowSha = 'c'.repeat(40);
    assert.throws(() => verifyBuildRun(candidate, execution.workflowSha, call, readGit), /BUILD_EXECUTION_CHANGED/u);
    marker.workflowSha = execution.workflowSha;
    Object.assign(run, { event: 'workflow_dispatch', head_branch: policy.defaultBranch, head_sha: execution.workflowSha });
    verifyBuildRun(candidate, execution.workflowSha, call, readGit);
    run.head_branch = 'candidate';
    assert.throws(() => verifyBuildRun(candidate, execution.workflowSha, call, readGit), /BUILD_RUN_INVALID/u);
    run.event = 'pull_request_target';
    pull.head.sha = 'd'.repeat(40);
    assert.throws(() => verifyBuildRun(candidate, execution.workflowSha, call, readGit), /BUILD_PR_CHANGED/u);
    candidate.inputs.submissionSha256 = 'e'.repeat(64);
    assert.throws(() => candidateIdentity(candidate), /CANDIDATE_INPUT_CHANGED/u);
});

test('归档来源只采纳已验签证书，拒绝伪 predicate、错误仓库、候选 ref 与自托管 runner', () => {
    const workflow = `https://github.com/${policy.repository}/${archivePath}@refs/heads/${policy.defaultBranch}`;
    const current = 'b'.repeat(40);
    const certificate = { sourceRepositoryIdentifier: policy.repositoryId, sourceRepositoryOwnerIdentifier: policy.repositoryOwnerId,
        buildSignerURI: workflow, buildConfigURI: workflow, sourceRepositoryRef: `refs/heads/${policy.defaultBranch}`,
        runnerEnvironment: 'github-hosted', buildTrigger: 'workflow_run', buildSignerDigest: current, sourceRepositoryDigest: current };
    const result = value => [{ verificationResult: { signature: { certificate: value }, statement: { predicate: certificate } } }];
    const readGit = args => assert.deepEqual(args, ['merge-base', '--is-ancestor', current, current]);
    assert.deepEqual(archiveCertificate(result(certificate), current, readGit), certificate);
    for (const key of Object.keys(certificate)) {
        assert.throws(() => archiveCertificate(result({ ...certificate, [key]: 'forged' }), current, readGit));
    }
    assert.throws(() => archiveCertificate(result(null), current, readGit), /SOURCE_INVALID/u);
    assert.throws(() => archiveCertificate(result(certificate), current, () => { throw new Error('not ancestor'); }), /not ancestor/u);
    const directory = fs.mkdtempSync(path.join(root, 'target/proof-'));
    const file = path.join(directory, 'candidate.json');
    fs.writeFileSync(file, '{}');
    assert.throws(() => verifyArchiveProof(file, file, current, readGit, (_command, _args, options) => {
        assert(!Object.keys(options.env).some(key => /TOKEN|SECRET|PRIVATE_KEY/iu.test(key)));
        assert.deepEqual(fs.readdirSync(options.env.GH_CONFIG_DIR), []);
        throw new Error('signature rejected');
    }), /signature rejected/u);
});
