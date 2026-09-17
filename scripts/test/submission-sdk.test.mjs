import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { prepareSubmission } from './local-sdk.mjs';
import { root, hash } from '../sdk.mjs';

test('固定 SDK 独立验证真实签名包、描述符、许可证及坏包，插件类不执行', () => {
    const sdk = prepareSubmission();
    const project = path.join(sdk.workspace, 'plugin');
    fs.mkdirSync(project);
    const descriptor = 'plugin.id=example-minimal\nplugin.version=2.3.4\nplugin.class=example.MustNeverLoad\n'
        + 'plugin.description=Example\npixiv.execution-mode=host-process-full-trust\npixiv.risk-signals=NETWORK\n';
    fs.writeFileSync(path.join(project, 'plugin.properties'), descriptor);
    // 无效 class 字节仍是合法静态输入；若检查器尝试加载它，本用例必定失败。
    fs.mkdirSync(path.join(project, 'example'));
    fs.writeFileSync(path.join(project, 'example/MustNeverLoad.class'), 'not executable class bytes');
    const artifact = path.join(sdk.workspace, 'plugin.jar');
    sdk.run('jar', ['--create', '--no-manifest', '--file', artifact, '-C', project, '.']);
    const facts = sdk.invoke({ command: 'inspect', file: artifact });
    assert.equal(facts.pluginId, 'example-minimal');
    assert.deepEqual(facts.descriptor.riskDeclaration, { present: true, signals: ['NETWORK'] });
    assert.equal(facts.sha256, hash(fs.readFileSync(artifact)));
    const keys = generateKeyPairSync('ed25519');
    const keyFile = sdk.save(Buffer.from(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })), '.pem');
    const signatureFile = path.join(sdk.workspace, 'signature.json');
    sdk.run('java', ['-cp', sdk.classpath, 'top.sywyar.pixivdownload.plugin.signature.cli.PluginSignatureTool',
        'artifact', '--artifact', artifact, '--plugin-id', facts.pluginId, '--version', facts.version,
        '--key-id', 'Test:Key', '--private-key', keyFile, '--out', signatureFile]);
    const publisher = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/structure/publisher.json'), 'utf8'));
    publisher.signingKeys[0] = { ...publisher.signingKeys[0], keyId: 'Test:Key',
        publicKeySpkiBase64: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    const submission = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json'), 'utf8'));
    submission.package = { url: 'https://example.org/plugin.jar', expectedSize: facts.size,
        sha256: facts.sha256, signature: JSON.parse(fs.readFileSync(signatureFile, 'utf8')) };
    const license = Buffer.from('test license text');
    fs.writeFileSync(path.join(project, 'LICENSE'), license);
    submission.license = { expression: 'MIT', files: [{ path: 'LICENSE', size: license.length, sha256: hash(license) }] };
    const input = { command: 'verify', file: artifact, submission: sdk.save(submission), publisher: sdk.save(publisher),
        publisherPath: 'publishers/101/example.json', path: 'submissions/101/example-minimal/2.3.4.json',
        previousReviewedCommit: null, sourceRoot: project, imagesRoot: project };
    assert(sdk.invoke(input).publisherKeyFingerprint);
    assert.throws(() => sdk.invoke({ ...input, previousReviewedCommit: '1'.repeat(40) }));
    submission.package.sha256 = '0'.repeat(64);
    assert.throws(() => sdk.invoke({ ...input, submission: sdk.save(submission) }));
    fs.appendFileSync(path.join(project, 'LICENSE'), 'changed');
    assert.throws(() => sdk.invoke(input));
    assert.throws(() => sdk.invoke({ command: 'inspect', file: sdk.save(Buffer.from('bad zip'), '.jar') }));
    fs.writeFileSync(path.join(project, 'plugin.properties'), descriptor.replace('NETWORK', 'UNKNOWN_RISK'));
    const badRisk = path.join(sdk.workspace, 'bad-risk.jar');
    sdk.run('jar', ['--create', '--no-manifest', '--file', badRisk, '-C', project, '.']);
    assert.throws(() => sdk.invoke({ command: 'inspect', file: badRisk }));
});

test('原始 JSON、内容请求 ID、静态图片与 Git 工程标识均由 SDK 重算', () => {
    const sdk = prepareSubmission();
    const publisherBytes = fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/structure/publisher.json'));
    const actual = sdk.document('PUBLISHER', publisherBytes, 'publishers/101/example.json');
    assert.equal(actual.sha256, hash(publisherBytes));
    assert.throws(() => sdk.document('PUBLISHER', publisherBytes, 'publishers/102/example.json'));
    assert.throws(() => sdk.document('PUBLISHER', Buffer.concat([publisherBytes, Buffer.from('{}')]), 'publishers/101/example.json'));
    assert.throws(() => sdk.document('PUBLISHER', Buffer.from('{"schemaVersion":1,"schemaVersion":1}'), 'publishers/101/example.json'));
    const rotation = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/structure/rotation.json'), 'utf8'));
    const canonical = sdk.invoke({ command: 'canonical', kind: 'ROTATION', file: sdk.save(rotation) });
    rotation.requestId = canonical.requestId;
    const rotationPath = 'key-rotations/101/example/' + rotation.requestId + '.json';
    assert.equal(sdk.document('ROTATION', rotation, rotationPath).value.requestId, rotation.requestId);
    rotation.payload.explanation = 'changed';
    assert.throws(() => sdk.document('ROTATION', rotation, rotationPath));
    assert.equal(sdk.invoke({ command: 'image', file: path.join(root, 'schemas/community/v1/vectors/images/static.png'), icon: true }).mediaType, 'image/png');
    assert.throws(() => sdk.invoke({ command: 'image', file: path.join(root, 'schemas/community/v1/vectors/images/animated.png'), icon: true }));
    const project = path.join(sdk.workspace, 'project');
    fs.mkdirSync(project);
    sdk.run('git', ['init', project]);
    fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    fs.writeFileSync(path.join(project, 'pom.xml'), '<project/>');
    assert.deepEqual(sdk.invoke({ command: 'projects', gitRoot: project }), []);
    sdk.run('git', ['-C', project, 'add', '.pixivdownloader-plugin-project', 'pom.xml']);
    assert.deepEqual(sdk.invoke({ command: 'projects', gitRoot: project }), [{ projectDir: '.', profiles: ['maven-java17-v1'] }]);
    fs.appendFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'wrong');
    assert.throws(() => sdk.invoke({ command: 'projects', gitRoot: project }));
});
