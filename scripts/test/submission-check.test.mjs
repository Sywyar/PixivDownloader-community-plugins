import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareSubmission } from '../submission-sdk.mjs';
import { signingTool, exportKey, signOperation } from '../submission-signing.mjs';
import { validateChanges, versionAvailable } from '../submission-check.mjs';
import { root, hash } from '../sdk.mjs';
import { checkPull } from '../submission-pr.mjs';
import { policy } from '../github.mjs';

test('独立投稿检查重新验证包与源码；身份冲突、版本占用、摘要变化均拒绝', async () => {
    const sdk = prepareSubmission();
    const sign = signingTool(sdk);
    const keyDirectory = path.join(sdk.workspace, 'keys');
    sign('keygen', '--directory', keyDirectory);
    const exported = exportKey(sdk, sign, path.join(keyDirectory, 'public-key.pem'), 'test:key');
    const { fingerprint, ...key } = exported;
    const fixture = name => JSON.parse(fs.readFileSync(path.join(root, `schemas/community/v1/vectors/${name}.json`), 'utf8'));
    const publisher = fixture('structure/publisher');
    publisher.signingKeys = [{ ...key, state: 'ACTIVE' }];
    const sourceFolder = path.join(sdk.workspace, 'archive-content');
    const sourceRoot = path.join(sourceFolder, 'fixed-commit');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    const license = Buffer.from('test license\n');
    fs.writeFileSync(path.join(sourceRoot, 'LICENSE'), license);
    const sourceZip = path.join(sdk.workspace, 'source.zip');
    sdk.run('jar', ['--create', '--no-manifest', '--file', sourceZip, '-C', sourceFolder, '.']);
    const pluginFolder = path.join(sdk.workspace, 'plugin');
    fs.mkdirSync(pluginFolder);
    fs.writeFileSync(path.join(pluginFolder, 'plugin.properties'), 'plugin.id=example-minimal\nplugin.version=2.3.4\n'
        + 'plugin.class=example.Plugin\nplugin.description=Example\npixiv.execution-mode=host-process-full-trust\npixiv.risk-signals=NETWORK\n');
    const artifact = path.join(sdk.workspace, 'plugin.jar');
    sdk.run('jar', ['--create', '--no-manifest', '--file', artifact, '-C', pluginFolder, '.']);
    const packageBytes = fs.readFileSync(artifact);
    const signature = path.join(sdk.workspace, 'artifact.sig');
    sign('artifact', '--artifact', artifact, '--plugin-id', 'example-minimal', '--version', '2.3.4',
        '--key-id', key.keyId, '--private-key', path.join(keyDirectory, 'private-key.pem'), '--out', signature);
    const submission = fixture('submission');
    const sourceBytes = fs.readFileSync(sourceZip);
    submission.source.archive = { url: `${submission.source.repository}/archive/${submission.source.commit}.zip`, size: sourceBytes.length, sha256: hash(sourceBytes) };
    submission.package = { ...submission.package, expectedSize: packageBytes.length, sha256: hash(packageBytes), signature: JSON.parse(fs.readFileSync(signature, 'utf8')) };
    submission.license = { expression: 'MIT', files: [{ path: 'LICENSE', size: license.length, sha256: hash(license) }] };
    const records = new Map();
    const published = [];
    const state = { tree: records, read: file => records.get(file) ?? null, published: () => published };
    const bytes = value => Buffer.from(JSON.stringify(value));
    const submissionPath = 'submissions/101/example-minimal/2.3.4.json';
    const changes = () => new Map([[submissionPath, bytes(submission)], ['publishers/101/example.json', bytes(publisher)]]);
    let downloads = 0;
    const input = { sdk, state, user: { id: '101', type: 'User' }, authorize: (owner, user) => owner.accountId === user.id,
        call: endpoint => endpoint.includes('/commits/') ? { sha: submission.source.commit }
            : { id: 100, owner: { id: 101 }, full_name: 'example/plugin' },
        fetch: async (url, file, _maximum, expected) => {
            downloads++;
            const body = url === submission.source.archive.url ? sourceBytes : packageBytes;
            if (body.length !== expected.size || hash(body) !== expected.sha256) throw new Error('DOWNLOAD_DIGEST_CHANGED');
            fs.writeFileSync(file, body, { flag: 'wx' });
            return { file, size: body.length, sha256: hash(body) };
        } };
    const result = await validateChanges({ ...input, changes: changes() });
    assert.equal(result.operation, 'FIRST_RELEASE');
    assert.equal(result.publisherKeyFingerprint, fingerprint);
    assert.deepEqual(result.descriptor.riskDeclaration.signals, ['NETWORK']);
    assert(fs.existsSync(result.sourceArchive));
    const before = downloads;
    await assert.rejects(validateChanges({ ...input, changes: changes(), user: { id: '202', type: 'User' } }), /OWNER_AUTHORIZATION_REQUIRED/u);
    assert.equal(downloads, before);
    const binding = fixture('structure/binding');
    binding.pluginId = submission.pluginId;
    binding.owner.accountId = '202';
    records.set(`plugin-bindings/${submission.pluginId}.json`, { value: binding, sha256: hash(bytes(binding)) });
    await assert.rejects(validateChanges({ ...input, changes: changes() }), /BINDING_CONFLICT/u);
    assert.equal(downloads, before);
    records.clear();
    const original = submission.package.sha256;
    submission.package.sha256 = '0'.repeat(64);
    await assert.rejects(validateChanges({ ...input, changes: changes() }), /DOWNLOAD_DIGEST_CHANGED/u);
    submission.package.sha256 = original;
    const version = fixture('structure/published');
    version.pluginId = submission.pluginId;
    version.package = submission.package;
    published.push({ value: version });
    assert.equal(versionAvailable(state, submission.pluginId, submission.version, original), published[0]);
    assert.throws(() => versionAvailable(state, submission.pluginId, submission.version, '0'.repeat(64)), /VERSION_DIGEST_CONFLICT/u);
    published.length = 0;
    records.set(submissionPath, {});
    assert.throws(() => versionAvailable(state, submission.pluginId, submission.version, original), /VERSION_SUBMISSION_OCCUPIED/u);
    // PR 检查直接读取原生 Git blob，不能使用向导给出的验证结果。
    const blobs = new Map();
    const entries = [...changes()].map(([file, body]) => {
        const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${body.length}\0`)).update(body).digest('hex');
        blobs.set(sha, { sha, size: body.length, encoding: 'base64', content: body.toString('base64') });
        return { path: file, mode: '100644', type: 'blob', size: body.length, sha };
    });
    const pull = { number: 17, state: 'open', user: { id: '101', type: 'User' }, changed_files: entries.length,
        base: { repo: { id: policy.repositoryId }, ref: policy.defaultBranch, sha: 'b'.repeat(40) },
        head: { repo: { id: '123', full_name: 'example/fork' }, sha: 'c'.repeat(40) } };
    const files = entries.map(entry => ({ filename: entry.path, status: 'added', sha: entry.sha }));
    let base = pull.base.sha;
    const native = (endpoint, options = {}) => {
        assert(!options.method || options.method === 'GET');
        if (endpoint === `repos/${policy.repository}`) return { full_name: policy.repository, id: policy.repositoryId,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint.endsWith('/pulls/17')) return structuredClone(pull);
        if (endpoint.includes('/pulls/17/files')) return [structuredClone(files)];
        if (endpoint.includes('/git/trees/')) return { tree: endpoint.startsWith('repos/example/fork/') ? entries : [] };
        if (endpoint.includes('/git/blobs/')) return blobs.get(endpoint.split('/').at(-1));
        if (endpoint.endsWith('/git/ref/heads/' + policy.defaultBranch)) return { object: { sha: base } };
        return input.call(endpoint);
    };
    assert.equal((await checkPull(17, sdk, native, input.fetch)).validation, 'STATIC_VALIDATED');
    files.push({ filename: 'scripts/candidate.mjs', status: 'added', sha: 'd'.repeat(40) }); pull.changed_files++;
    await assert.rejects(checkPull(17, sdk, native, input.fetch), /UNEXPECTED_SUBMISSION_FILE/u);
    files.pop(); pull.changed_files--;
    base = 'e'.repeat(40);
    await assert.rejects(checkPull(17, sdk, native, input.fetch), /PR_OR_BASE_CHANGED/u);
});

test('轮换、状态请求及双方转移批准独立校验签名与受保护身份', async () => {
    const sdk = prepareSubmission();
    const sign = signingTool(sdk);
    const makeKey = () => {
        const directory = path.join(sdk.workspace, crypto.randomUUID());
        sign('keygen', '--directory', directory);
        const { fingerprint, ...key } = exportKey(sdk, sign, path.join(directory, 'public-key.pem'), crypto.randomUUID());
        return { key, privateFile: path.join(directory, 'private-key.pem') };
    };
    const current = makeKey(); const next = makeKey();
    const owner = { accountId: '101', accountType: 'User', publisherId: 'example' };
    const publisher = { schemaVersion: 1, publisherId: 'example', displayName: 'Example', githubAccount: { id: '101', type: 'User', loginAtRegistration: 'example' },
        signingKeys: [{ ...current.key, state: 'ACTIVE' }] };
    const records = new Map();
    const store = (file, kind, value) => { const bytes = Buffer.from(JSON.stringify(value)); const record = { ...sdk.document(kind, bytes, file), bytes, path: file }; records.set(file, record); return record; };
    const publisherRecord = store('publishers/101/example.json', 'PUBLISHER', publisher);
    const binding = store('plugin-bindings/demo.json', 'BINDING', { schemaVersion: 1, pluginId: 'demo', owner, effectiveRequestId: null, updatedAt: '2026-01-02T03:04:05Z' });
    const state = { tree: records, read: file => records.get(file) ?? null,
        currentStatus: (pluginId, version, packageSha256, request) => sdk.invoke({ command: 'status', pluginId, version, packageSha256,
            history: [{ file: sdk.save(request), decisionSha256: request.requestId }] }),
        published: () => [{ value: { version: '2.3.4', package: { sha256: 'a'.repeat(64) } } }] };
    const input = { sdk, state, user: { id: '101', type: 'User' }, authorize: (owner, user) => owner.accountId === user.id };
    const rotation = signOperation(sdk, sign, 'ROTATION', { schemaVersion: 1, payload: { publisherId: 'example', githubAccount: { id: '101', type: 'User' },
        publisherRecordSha256: publisherRecord.sha256, oldKeyId: current.key.keyId, newKey: next.key, reasonCode: 'ROUTINE_ROTATION', explanation: 'Rotate key' } },
    { newKey: { keyId: next.key.keyId, privateFile: next.privateFile } });
    const rotationChanges = new Map([[`key-rotations/101/example/${rotation.requestId}.json`, Buffer.from(JSON.stringify(rotation))]]);
    assert.equal((await validateChanges({ ...input, changes: rotationChanges })).operation, 'KEY_ROTATION');
    publisherRecord.sha256 = 'b'.repeat(64);
    await assert.rejects(validateChanges({ ...input, changes: rotationChanges }), /PUBLISHER_CHANGED/u);
    publisherRecord.sha256 = hash(publisherRecord.bytes);
    const status = signOperation(sdk, sign, 'STATUS_REQUEST', { schemaVersion: 1, payload: { owner, requester: { id: '101', type: 'User' }, pluginBindingSha256: binding.sha256,
        pluginId: 'demo', version: '2.3.4', packageSha256: 'a'.repeat(64), action: 'YANK', reasonCode: 'FUNCTIONAL_DEFECT', explanation: 'Incorrect output' } }, {});
    const statusChanges = new Map([[`version-status-requests/101/demo/2.3.4/${status.requestId}.json`, Buffer.from(JSON.stringify(status))]]);
    assert.equal((await validateChanges({ ...input, changes: statusChanges })).operation, 'YANK');
    await assert.rejects(validateChanges({ ...input, changes: statusChanges, user: { id: '202', type: 'User' } }), /REQUESTER_MISMATCH/u);
    const transfer = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload: { pluginId: 'demo', pluginBindingSha256: binding.sha256, from: owner,
        to: { accountId: '202', accountType: 'User', publisherId: 'target' }, targetPublisherRecordSha256: null, targetKey: next.key,
        targetPublisherDisplayName: 'Target', mode: 'REGULAR', explanation: 'Transfer maintenance' } }, { targetKey: { keyId: next.key.keyId, privateFile: next.privateFile } });
    const directory = `ownership-transfers/demo/${transfer.requestId}`;
    const proposalPath = `${directory}/proposal.json`;
    const transferChanges = new Map([[proposalPath, Buffer.from(JSON.stringify(transfer))]]);
    assert.equal((await validateChanges({ ...input, changes: transferChanges })).operation, 'OWNERSHIP_TRANSFER');
    transferChanges.set(`${directory}/approvals/to/101.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: transfer.requestId, role: 'TO' })));
    await assert.rejects(validateChanges({ ...input, changes: transferChanges }), /OWNER_AUTHORIZATION_REQUIRED/u);
    store(proposalPath, 'TRANSFER', transfer);
    const approval = new Map([[`${directory}/approvals/to/202.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, requestId: transfer.requestId, role: 'TO' }))]]);
    assert.equal((await validateChanges({ ...input, changes: approval, user: { id: '202', type: 'User' } })).operation, 'OWNERSHIP_TRANSFER');
});
