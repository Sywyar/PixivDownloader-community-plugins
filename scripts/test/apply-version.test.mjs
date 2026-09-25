import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission, withEmergencyState, withRepositoryFiles } from './local-sdk.mjs';
import { signingTool } from '../submission-signing.mjs';
import { applySdk } from '../apply-sdk.mjs';
import { publishVersion } from '../apply-version.mjs';
import { currentAdmission } from '../apply-context.mjs';
import { confirmPublication, finalizeReleases } from '../publication-releases.mjs';
import { makeReceipt, receiptPath } from '../apply-result.mjs';
import { proofPath, reference } from '../receipt-storage.mjs';
import { scanBuild } from '../build-evidence.mjs';
import { encoded, packageName } from '../apply-generation.mjs';
import { hash, root } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';

test('真实签名包经审核合并后公开候选 Release，同版本重放不产生写入', async () => {
    const sdk = prepareSubmission(), sign = signingTool(sdk), adapter = applySdk(sdk);
    const records = new Map();
    const state = { tree: records, raw: file => records.get(file) ?? null,
        reference(ref) { const bytes = records.get(ref.path); assert.equal(bytes.length, ref.size); assert.equal(hash(bytes), ref.sha256); return bytes; },
        read(file, kind) { const bytes = records.get(file); return bytes ? { ...sdk.document(kind, bytes, file), bytes, path: file } : null; },
        published(plugin) { return [...records.keys()].filter(file => file.startsWith(`published/${plugin}/`)).map(file => this.read(file, 'PUBLISHED')); } };
    const pair = crypto.generateKeyPairSync('ed25519'), privateFile = path.join(sdk.workspace, 'publisher.pem');
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const key = { keyId: crypto.randomUUID(), algorithm: 'Ed25519', publicKeySpkiBase64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), state: 'ACTIVE' };
    const community = crypto.generateKeyPairSync('ed25519');
    const privateBytes = Buffer.from(community.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const communityKey = { ...key, keyId: crypto.randomUUID(), publicKeySpkiBase64: community.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), publisher: 'Community', trustLabel: 'Community', official: false };
    const project = path.join(sdk.workspace, 'compiled'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'Probe.java'), 'public class Probe { public int value() { return 1; } }');
    sdk.run('javac', ['--release', '17', '-d', project, path.join(project, 'Probe.java')]);
    fs.writeFileSync(path.join(project, 'plugin.properties'), 'plugin.id=example-minimal\nplugin.version=2.3.4\nplugin.class=Probe\nplugin.description=Example\npixiv.execution-mode=host-process-full-trust\npixiv.risk-signals=\n');
    const artifact = path.join(sdk.workspace, 'plugin.jar');
    sdk.run('jar', ['--create', '--no-manifest', '--file', artifact, '-C', project, '.']);
    const bytes = fs.readFileSync(artifact), inspected = sdk.invoke({ command: 'inspect', file: artifact });
    const signature = path.join(sdk.workspace, 'publisher-signature.json');
    sign('artifact', '--artifact', artifact, '--plugin-id', 'example-minimal', '--version', '2.3.4', '--key-id', key.keyId, '--private-key', privateFile, '--out', signature);
    const submission = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json')));
    submission.package = { ...submission.package, expectedSize: bytes.length, sha256: hash(bytes), signature: JSON.parse(fs.readFileSync(signature)) };
    const submissionPath = 'submissions/101/example-minimal/2.3.4.json'; records.set(submissionPath, encoded(submission));
    const owner = { accountId: '101', accountType: 'User', publisherId: 'example' };
    records.set('publishers/101/example.json', encoded({ schemaVersion: 1, publisherId: 'example', displayName: 'Example',
        githubAccount: { id: '101', type: 'User', loginAtRegistration: 'example' }, signingKeys: [key] }));
    const current = 'b'.repeat(40), appliedAt = '2026-01-02T00:00:00Z';
    const pr = { number: 7, state: 'open', merged: false, draft: false, merge_commit_sha: null, user: { id: 101, type: 'User' }, changed_files: 1,
        head: { sha: 'a'.repeat(40), repo: { id: 401, full_name: 'example/fork' } }, base: { sha: current, ref: policy.defaultBranch, repo: { id: policy.repositoryId } } };
    const reviewer = { id: policy.repositoryOwnerId, type: 'User', role_name: 'admin' };
    const context = { current, run: { id: 91, run_attempt: 1, event: 'workflow_dispatch', triggering_actor: reviewer } };
    const call = withEmergencyState(withRepositoryFiles(withRepositoryFiles(endpoint => {
        const route = endpoint.replace(/([?&])per_page=100/u, '');
        if (route === `${prefix}/pulls/7`) return pr;
        if (route === `${prefix}/pulls/7/files`) return [[{ filename: submissionPath, status: 'added', sha: 'd'.repeat(40) }]];
        if (route === `${prefix}/collaborators?affiliation=all`) return [[reviewer]];
        if (route === `${prefix}/pulls/7/reviews`) return [[{ id: 91, user: reviewer, state: 'APPROVED', commit_id: pr.head.sha,
            submitted_at: '2026-01-01T00:00:00Z', pull_request_url: `https://api.github.com/${prefix}/pulls/7` }]];
        if (route.startsWith(`${prefix}/actions/workflows/community-review-decision.yml/runs?`)) return [{ workflow_runs: [], total_count: 0 }];
        if (route === `${prefix}/environments/release`) return { id: 8, can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true },
            protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer }] }] };
        if (route === `${prefix}/environments/release/deployment-branch-policies`) return [{ branch_policies: [{ id: 9, type: 'branch', name: 'master' }], total_count: 1 }];
        if (route === `${prefix}/actions/runs/91/approvals`) return [{ state: 'approved', environments: [{ id: 8, name: 'release' }], user: reviewer }];
        if (route === `${prefix}/releases/501/assets`) return [[{ id: 601, name: packageName({ ...submission, owner }), size: bytes.length, digest: 'sha256:' + hash(bytes), state: 'uploaded' }]];
        throw new Error('Unexpected request ' + route);
    }, policy.repository, new Map([[current, records]])), 'example/fork', new Map([[pr.head.sha, records]])));
    const compiled = fs.readFileSync(path.join(project, 'Probe.class'));
    const scan = scanBuild(sdk, { artifact, package: inspected, compiledClasses: [{ path: 'target/classes/Probe.class', size: compiled.length, sha256: hash(compiled) }],
        dependencyFiles: [], dependencyMetadata: [], sourceFiles: [], model: { dependencies: [] }, jdkVersion: '17.0.1+1' }, submission,
    { runId: '81', runAttempt: 1, headSha: pr.head.sha });
    const binding = encoded({ schemaVersion: 1, pluginId: submission.pluginId, owner, effectiveRequestId: null, updatedAt: appliedAt });
    const version = { releaseId: '501', tag: 'candidate/' + 'c'.repeat(64), directory: sdk.workspace, publicationBindingSha256: hash(binding),
        checked: { operation: 'FIRST_RELEASE', owner, submission, submissionPath, submissionSha256: hash(records.get(submissionPath)), descriptor: inspected.descriptor,
            publisherSha256: hash(records.get('publishers/101/example.json')), bindingSha256: hash(Buffer.from('null')), package: { size: bytes.length, sha256: hash(bytes) },
            pr: { head: pr.head.sha, base: current, user: { id: '101', type: 'User' } } },
        candidate: { inputSha256: 'c'.repeat(64), scan, evidence: Object.values(scan).filter(ref => ref?.path), files: [{ path: 'plugin.jar' }] },
        report: JSON.parse(fs.readFileSync(path.join(sdk.workspace, scan.riskReportRef.path))) };
    const admission = currentAdmission(7, sdk, context, version, call, () => '');
    const options = { sdk, adapter, state, version, pr, context, admission, inputs: { recoveryApproved: false }, communityKey, privateBytes, appliedAt, call };
    const originalRecords = new Map(records);
    const result = publishVersion(options);
    assert.equal(result.published.assuranceLevel, 'SOURCE_REVIEWED');
    assert.equal(result.published.sourceCommit, submission.source.commit);
    assert.equal(result.release.id, '501'); assert.equal(result.release.packageSha256, hash(bytes));
    assert.equal(result.release.originalTag, version.tag);
    result.writes.set('generated/community-key.json', encoded(communityKey));
    const publication = adapter.archive(result.writes.get(`published/${submission.pluginId}/${submission.version}.json`));
    const publisher = adapter.archive(records.get('publishers/101/example.json'));
    const generated = 'd'.repeat(40), merged = 'e'.repeat(40);
    const confirm = { command: 'confirm-publication', communityKey, repositoryId: 'pixivdownloader-community',
        published: publication, publisher, packageFile: 'plugin.jar', merge: {
            pr: { githubRepositoryId: policy.repositoryId, number: pr.number, authorAccountId: '101', headRepositoryId: '401',
                headSha: generated, baseSha: current, mergeSha: merged }, generatedHead: generated,
            generatedParents: [pr.head.sha], mergeParents: [current, generated], preparedRecord: publication } };
    assert.equal(adapter.invoke(confirm).verified, true);
    assert.throws(() => adapter.invoke({ ...confirm, merge: { ...confirm.merge, generatedParents: ['f'.repeat(40)] } }), /PREPARED_MERGE_MISMATCH/);
    result.writes.forEach((bytes, file) => records.set(file, bytes));
    const completion = { receipt: { baseSha: current }, pr: { ...pr, state: 'closed', merged: true, head: { ...pr.head, sha: generated }, merge_commit_sha: merged },
        commit: { sha: generated, parents: [{ sha: pr.head.sha }] }, merge: { parents: [{ sha: current }, { sha: generated }] } };
    assert.equal(confirmPublication(sdk, state, result.published, artifact, completion).verified, true);
    assert.equal(publishVersion(options).writes.size, 0);
    assert.throws(() => publishVersion({ ...options, version: { ...version, checked: { ...version.checked, package: { ...version.checked.package, sha256: 'f'.repeat(64) } } } }), /VERSION_DIGEST_CONFLICT/);
    const put = (file, value) => { const bytes = encoded(value); result.writes.set(file, bytes); return { path: file, size: bytes.length, sha256: hash(bytes) }; };
    const data = put('generated/generations/1/catalog.json', {});
    put('generated/current.json', { sequence: 1, descriptor: data, directory: data, catalog: data,
        revocations: put('revocations.json', { entries: [] }) });
    const inputFiles = [{ filename: submissionPath, status: 'added', sha: reference(originalRecords.get(submissionPath)).blob }];
    const made = makeReceipt({ requestId: hash(originalRecords.get(submissionPath)), operation: 'FIRST_RELEASE', pr,
        current, run: context.run, writes: result.writes, state: { raw: file => originalRecords.get(file) },
        releases: [result.release], appliedAt, inputFiles });
    result.writes.forEach((value, file) => records.set(file, value));
    const attestation = encoded({});
    const pointer = { schemaVersion: 2, manifest: reference(made.bytes), attestation: reference(attestation) };
    records.set(proofPath(pointer.manifest.sha256), made.bytes);
    records.set(proofPath(pointer.attestation.sha256), attestation);
    records.set(receiptPath(made.value.requestId), encoded(pointer));
    const files = [...records.keys()].filter(file => !originalRecords.get(file)?.equals(records.get(file)))
        .map(filename => ({ filename, status: originalRecords.has(filename) ? 'modified' : 'added' }));
    const mergedPr = { ...completion.pr, changed_files: files.length + inputFiles.length };
    const baseRecords = new Map(originalRecords); baseRecords.delete(submissionPath);
    const release = { id: 501, draft: true, published_at: null, tag_name: result.release.originalTag };
    const assets = structuredClone(result.release.originalAssets), bodies = new Map([['601', bytes]]);
    let tag = null, promotions = 0;
    const finalCall = withEmergencyState(withRepositoryFiles((endpoint, request = {}) => {
        const route = endpoint.split('?')[0];
        if (route === `${prefix}/branches/master`) return { commit: { sha: merged } };
        if (route === `${prefix}/pulls/7`) return structuredClone(mergedPr);
        if (route === `${prefix}/pulls/7/files`) return [[...inputFiles, ...files]];
        if (route.endsWith('/check-runs')) return [{ total_count: 4, check_runs: policy.requiredContexts.map((name, i) => ({
            id: i + 1, name, app: policy.gateApp, head_sha: generated, external_id: '91:1:7', status: 'completed', conclusion: 'success' })) }];
        if (route.startsWith(`${prefix}/git/commits/`)) {
            const sha = route.split('/').at(-1);
            return { sha, parents: (sha === generated ? [pr.head.sha, current] : [current, generated]).map(sha => ({ sha })) };
        }
        if (route === `${prefix}/releases/501/assets`) return [structuredClone(assets)];
        if (route.startsWith(`${prefix}/git/matching-refs/tags/`)) return [tag ? [tag] : []];
        if (route === `${prefix}/releases/501`) {
            if (request.method === 'PATCH') {
                if (request.body.draft === false) {
                    promotions++; release.published_at = appliedAt;
                    tag = { ref: 'refs/tags/' + request.body.tag_name, object: { type: 'commit', sha: merged } };
                }
                Object.assign(release, request.body);
            }
            return structuredClone(release);
        }
        assert.fail(endpoint);
    }, policy.repository, new Map([[current, baseRecords], [pr.head.sha, originalRecords], [generated, records], [merged, records]])));
    const download = (endpoint, file, max, expected) => {
        const bytes = bodies.get(endpoint.split('/').at(-1));
        assert.ok(bytes.length <= max); assert.equal(bytes.length, expected.size); assert.equal(hash(bytes), expected.sha256);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
    };
    const transport = { call: finalCall, readGit: () => '', verify: () => ({ sourceRepositoryDigest: current }), download,
        upload: (releaseId, file, name) => {
            assert.equal(String(releaseId), '501');
            const bytes = fs.readFileSync(file), id = 601 + assets.length;
            const asset = { id, name, size: bytes.length, digest: 'sha256:' + hash(bytes), state: 'uploaded' };
            assets.push(asset); bodies.set(String(id), bytes); return asset;
        }, fetch: (url, file, max, expected) => {
            assert.equal(url, `https://github.com/${policy.repository}/releases/download/${result.release.tag}/${result.release.packageName}`);
            return download(`${prefix}/releases/assets/601`, file, max, expected);
        } };
    assert.equal((await finalizeReleases({ current: merged }, sdk, transport)).applied, true);
    assert.equal(release.draft, false); assert.equal(promotions, 1);
    assert.equal(release.tag_name, result.release.tag); assert.equal(release.target_commitish, merged);
    assert.deepEqual(bodies.get('601'), bytes);
    assert.equal((await finalizeReleases({ current: merged }, sdk, transport)).applied, true);
    assert.equal(promotions, 1);
    sign.close(); privateBytes.fill(0);
});
