import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import channel from '../../tools/submission-channel.cjs';
import { embeddedVerifier, runtimeManifest, issueChannel } from '../submission-channel.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const now = Math.floor(Date.now() / 1000);
const payload = { schemaVersion: 1, channel: channel.CHANNEL, repository: channel.REPOSITORY,
    sequence: 1, runtimeCommit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), issuedAt: now, expiresAt: now + channel.MAX_AGE };
const sign = value => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    return Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, privateKey).toString('base64') }));
};

test('固定入口嵌入交付的完整校验器，签名清单绑定仓库和工具摘要', () => {
    assert.equal(embeddedVerifier(), fs.readFileSync(new URL('../../tools/submission-channel.cjs', import.meta.url), 'utf8').trimEnd());
    const bytes = channel.signChannel(payload, pem);
    assert.deepEqual(channel.selectChannel(bytes, null, spki, now), payload);
    assert.deepEqual(channel.selectChannel(bytes, bytes, spki, now), payload);
    const wrong = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    assert.throws(() => channel.selectChannel(bytes, null, wrong, now), /SIGNATURE_INVALID/u);
    const changed = JSON.parse(bytes);
    changed.payload = Buffer.from(JSON.stringify({ ...payload, runtimeCommit: 'c'.repeat(40) })).toString('base64');
    assert.throws(() => channel.selectChannel(Buffer.from(JSON.stringify(changed)), null, spki, now), /SIGNATURE_INVALID/u);
});

test('过期、未来、非法字段、非规范编码及大小边界都不能选择工具', () => {
    const invalid = [
        { expiresAt: now }, { issuedAt: now + channel.CLOCK_SKEW + 1, expiresAt: now + 1000 },
        { expiresAt: now + channel.MAX_AGE + 1 }, { schemaVersion: 2 }, { channel: 'another-channel' },
        { repository: 'attacker/repo' }, { sequence: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
        { runtimeCommit: '../master' }, { runtimeCommit: '0'.repeat(40) }, { manifestSha256: '0'.repeat(64) },
        { extra: true }, { issuedAt: null }, { expiresAt: 'later' },
    ];
    for (const change of invalid) assert.throws(() => channel.selectChannel(sign({ ...payload, ...change }), null, spki, now), /BOOTSTRAP_CHANNEL_/u);
    assert.throws(() => channel.selectChannel(sign(JSON.stringify(payload).replace('"sequence":1', '"sequence":2,"sequence":1')), null, spki, now), /INVALID/u);
    assert.throws(() => channel.selectChannel(sign(JSON.stringify(payload, null, 2)), null, spki, now), /INVALID/u);
    const valid = sign(payload);
    assert.throws(() => channel.selectChannel(Buffer.concat([valid, Buffer.from('\n')]), null, spki, now), /INVALID/u);
    assert.throws(() => channel.selectChannel(Buffer.alloc(channel.MAX_BYTES), null, spki, now), /INVALID/u);
    assert.throws(() => channel.selectChannel(Buffer.alloc(channel.MAX_BYTES + 1), null, spki, now), /SIZE_EXCEEDED/u);
    assert.throws(() => channel.base64('YQ'), /INVALID/u);
    assert.throws(() => channel.base64('YQ==\n'), /INVALID/u);
    const envelope = JSON.parse(valid);
    assert.throws(() => channel.selectChannel(Buffer.from(JSON.stringify({ ...envelope, signature: Buffer.alloc(63).toString('base64') })), null, spki, now), /SIGNATURE_INVALID/u);
});

test('相同序号只能重用原字节，过期历史仍阻止回退但允许有效续签', () => {
    const original = sign(payload);
    const newer = sign({ ...payload, sequence: 2, issuedAt: now + 1, expiresAt: now + 100 });
    assert.equal(channel.selectChannel(newer, original, spki, now + 1).sequence, 2);
    assert.throws(() => channel.selectChannel(original, newer, spki, now + 1), /ROLLBACK/u);
    assert.throws(() => channel.selectChannel(sign({ ...payload, manifestSha256: 'c'.repeat(64) }), original, spki, now), /SEQUENCE_CONFLICT/u);
    const expired = sign({ ...payload, issuedAt: now - 100, expiresAt: now - 1 });
    assert.equal(channel.selectChannel(newer, expired, spki, now + 1).sequence, 2);
    assert.throws(() => channel.selectChannel(newer, Buffer.from('{}'), spki, now), /INVALID/u);
});

test('签发只接受主线祖先及实际匹配的 Git 普通文件，续签递增且不覆盖输入', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-channel-git-'));
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'master');
    git('config', 'user.name', 'Channel fixture'); git('config', 'user.email', 'channel@example.invalid');
    fs.mkdirSync(path.join(directory, 'scripts')); fs.mkdirSync(path.join(directory, 'tools'));
    const runtime = Buffer.from('process.exit(0);\n');
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: 'scripts/submit.mjs', size: runtime.length,
        sha256: crypto.createHash('sha256').update(runtime).digest('hex') }] }));
    fs.writeFileSync(path.join(directory, 'scripts/submit.mjs'), runtime);
    fs.writeFileSync(path.join(directory, 'tools/submission-files.json'), manifest);
    git('add', 'scripts/submit.mjs', 'tools/submission-files.json'); git('commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    assert.equal(runtimeManifest(directory, commit, 'master'), crypto.createHash('sha256').update(manifest).digest('hex'));
    const first = issueChannel({ directory, commit, key: spki, privateKey: pem, now, base: 'master' });
    const next = issueChannel({ directory, commit, previous: first, key: spki, privateKey: pem, now: now + 1, base: 'master' });
    assert.equal(channel.selectChannel(next, first, spki, now + 1).sequence, 2);
    // 已发布的 schemaVersion 2 SDK 渠道兼容夹具。
    const sdk = {"version":"1.1.0","sourceCommit":"14aae5b2f47f789318bb70f547a00ce2b554341e","archive":{"file":"PixivDownloader-Plugin-SDK-1.1.0.zip","size":36949628,"sha256":"0d7baec1a869b5ac416a66cd8adc293e66ee062b1d4b4d54a8f37f8d5f8adad1"},"files":[{"path":"contracts/community/v1/bundle-manifest.json","size":7673,"sha256":"515776ecaeaabbab9015f365e1ebfe184f51f24df553e4841c3dd01713e52670"},{"path":"contracts/community/v1/catalogs.json","size":999,"sha256":"84233504ff86b524917d175219d94a1ded1d8ba43799fad41fae77bedf06c799"},{"path":"contracts/community/v1/community.schema.json","size":75546,"sha256":"e41a621747d7aa8b8a39e4f2f3c6c78bc43dc544ad1cabd6822379c727cccc4e"},{"path":"contracts/community/v1/licenses/0BSD.txt","size":643,"sha256":"e3f18c71e10d673590eb9856c1d79dd3b4b0d65404efb5e8584dbede7edd608b"},{"path":"contracts/community/v1/licenses/AGPL-3.0-only.txt","size":34020,"sha256":"d8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee"},{"path":"contracts/community/v1/licenses/AGPL-3.0-or-later.txt","size":34020,"sha256":"d8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee"},{"path":"contracts/community/v1/licenses/Apache-2.0.txt","size":10280,"sha256":"074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff"},{"path":"contracts/community/v1/licenses/BSD-2-Clause.txt","size":1266,"sha256":"017b5ee48f680e82cba79141c7895a1f02b856df2512225f5c427fe36765ef0b"},{"path":"contracts/community/v1/licenses/BSD-3-Clause.txt","size":1459,"sha256":"3cf06aba3588c41c514f6946bb2d757b413ff6491647d474800f55edca75dcb4"},{"path":"contracts/community/v1/licenses/CC0-1.0.txt","size":7048,"sha256":"a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499"},{"path":"contracts/community/v1/licenses/GPL-3.0-only.txt","size":34674,"sha256":"fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0"},{"path":"contracts/community/v1/licenses/GPL-3.0-or-later.txt","size":34674,"sha256":"fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0"},{"path":"contracts/community/v1/licenses/ISC.txt","size":823,"sha256":"f2ec607f67bb0dd3053b49835b02110d5cd0f8eb6da3aac4dc0b142a6b299be9"},{"path":"contracts/community/v1/licenses/LGPL-3.0-only.txt","size":42098,"sha256":"996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1"},{"path":"contracts/community/v1/licenses/LGPL-3.0-or-later.txt","size":42098,"sha256":"996af0513df21f7496288951c41428a03c174e9e4a9d63665c57d670f845ccb1"},{"path":"contracts/community/v1/licenses/MIT.txt","size":1078,"sha256":"b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5"},{"path":"contracts/community/v1/licenses/MPL-2.0.txt","size":16726,"sha256":"3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04"},{"path":"contracts/community/v1/licenses/Unlicense.txt","size":1211,"sha256":"0bdebfeda07d45dada625ae1317c6f833186e798b171d0db640bcf32e92a8240"},{"path":"contracts/community/v1/messages.json","size":2821,"sha256":"bb3f4e79d049d6c2fd03ad5db2b79f906253756944d368c21cd8ce711633beba"},{"path":"contracts/community/v1/spdx.json","size":21594,"sha256":"fce30fe9101f0a3d56d34f5790f2d6c05decf6a09e9b257e1c8bcef20762e04b"},{"path":"contracts/community/v1/vectors/images/animated.png","size":211,"sha256":"e2d0700d72cf65a4919fb1978be7febc07a8b0d5f08ef49c0e07870bbc8fa5e1"},{"path":"contracts/community/v1/vectors/images/animated.webp","size":144,"sha256":"dd37f20748326ac0ee2dbb3ef4e3cc152f2117519ccb59663f1a7d859201ed82"},{"path":"contracts/community/v1/vectors/images/static.jpg","size":632,"sha256":"8b32cdb1ac2c881cc3326017277ea90f2092ec952073929ba212789bb5c1cbe0"},{"path":"contracts/community/v1/vectors/images/static.png","size":78,"sha256":"d6cd204a858fda5c086ee064382f33db954ecbabd8c3f01d62d95720188e5a6b"},{"path":"contracts/community/v1/vectors/images/static.webp","size":38,"sha256":"cbe58301bcdc7b49229aae8681e11f5fa73412fe6d7bea92e9d9644069ee0991"},{"path":"contracts/community/v1/vectors/json.json","size":3744,"sha256":"be8585d7f1195f693c143adc104dda04087d40b490317d2375e3e8cf90232747"},{"path":"contracts/community/v1/vectors/revocation-snapshots.json","size":1707,"sha256":"fd0519b54ebb06cb2b0441751dc0c89a413f09c3e9439e6e8b697d8dc3ef04b5"},{"path":"contracts/community/v1/vectors/signatures.properties","size":4172,"sha256":"f6dfda14a5894a532efc1467ac364e0e792a8723116dce6c50edc6d54eca24b8"},{"path":"contracts/community/v1/vectors/state-transitions.json","size":3617,"sha256":"94e1367ad6698d62239e4e80f7fbd4aee66de43bb914e8804852091ee9cbf728"},{"path":"contracts/community/v1/vectors/structure/approval.json","size":126,"sha256":"97fdf30be50b3b6f66a849c07848a4671dd2642b20600c8c0da17c2d791674b2"},{"path":"contracts/community/v1/vectors/structure/audit.json","size":1204,"sha256":"ab3de8ce27720a522c7a174f3682598d2e62f64509c6818732b58c5ea85accce"},{"path":"contracts/community/v1/vectors/structure/binding.json","size":214,"sha256":"2c5638af6425b7de2bc53c64f91d330d68c09bc69aa3f21d243050a7ee7cf4f3"},{"path":"contracts/community/v1/vectors/structure/decision.json","size":963,"sha256":"f0b30d195e3b08acda3ba8cb2bd23b9eb0d177547fa287e9d2a5a3ac46e9787d"},{"path":"contracts/community/v1/vectors/structure/directoryRoot.json","size":354,"sha256":"50cb7095ebacd4d6e8d949828aa501b41db86faafaf599902e553cbbb6a457b5"},{"path":"contracts/community/v1/vectors/structure/directoryShard.json","size":956,"sha256":"1531fefff38e94d72b0280b3a039c59861d91123eddff094989723d1495130f7"},{"path":"contracts/community/v1/vectors/structure/emergencyKeyBlock.json","size":700,"sha256":"8fe42cb7c090df8d58d71a6572c71bb867c5e9dc6937588b5b38a1058c4a7f55"},{"path":"contracts/community/v1/vectors/structure/emergencyRequest.json","size":490,"sha256":"a6ac6415d56e48ac5495a3778dc618a7a4a99282ba7e88879dee88e4bcee64a0"},{"path":"contracts/community/v1/vectors/structure/emergencyState.json","size":90,"sha256":"0d7bfa8a437a9bf24bb64bab3fca92f9f24e69397f0054995403cd1593f2d18d"},{"path":"contracts/community/v1/vectors/structure/published.json","size":1394,"sha256":"fb9f2c9598f8a755c572f3016c16245c4db1c1f4f04c830627ac737552ff2dba"},{"path":"contracts/community/v1/vectors/structure/publisher.json","size":394,"sha256":"498f5d2e167daa16a1079d3e77d809a2a8ae008785814679ade405ab027da56f"},{"path":"contracts/community/v1/vectors/structure/review.json","size":3238,"sha256":"3586777e4b4072176b0ed0b79587c21db2237abc38ef17a7aef12a7662dbcbe6"},{"path":"contracts/community/v1/vectors/structure/rotation.json","size":825,"sha256":"cab965d6a5a8a22428c64c31b0fbb5fd180660f0c71748eea87f53f9d2595a80"},{"path":"contracts/community/v1/vectors/structure/statusRequest.json","size":649,"sha256":"8bc789c50e8155a0305d67359e6eaa36456e6aaf568f5f5387e328d46f37208c"},{"path":"contracts/community/v1/vectors/structure/transfer.json","size":1022,"sha256":"307258a8f688a1c08c8dde06eab40c5f1ac59eb8d5c653acf1d036a25a9cfe02"},{"path":"contracts/community/v1/vectors/submission.json","size":1421,"sha256":"32f1606169c0ff504ad1c0fe1dfe34532e8c4af1ac117a04459510c03982ba2b"},{"path":"tools/build-model.mjs","size":5568,"sha256":"ebf31f4a72c21ed611e5085291292765a3c702ae8ec50b67de0f1cc5b25e637f"},{"path":"tools/community-contract.json","size":379,"sha256":"13771ce81fca04223c4bcf522b992a216c2baa40b902bce0ad94e0e5ffd6888a"},{"path":"tools/community-model.gradle","size":1154,"sha256":"f04a332194c4332b2bee649e3c00897b4f08c417f371813212be62e98a34dc7a"},{"path":"tools/sdk-tools.jar","size":16348592,"sha256":"41c78e4e0dbf8a5a59297a61e34b7c95ca5192829203a47ea16efc95b269d7ea"}]};
    const manifestV2 = Buffer.from(JSON.stringify({ ...JSON.parse(manifest), schemaVersion: 2, sdk }));
    fs.writeFileSync(path.join(directory, 'tools/submission-files.json'), manifestV2);
    git('add', 'tools/submission-files.json'); git('commit', '-m', 'sdk reference');
    const v2 = issueChannel({ directory, commit: git('rev-parse', 'HEAD'), previous: next, key: spki, privateKey: pem, now: now + 2, base: 'master' });
    assert.equal(channel.selectChannel(v2, next, spki, now + 2).manifestSha256, crypto.createHash('sha256').update(manifestV2).digest('hex'));
    assert.notEqual(channel.selectChannel(v2, next, spki, now + 2).manifestSha256, payload.manifestSha256);
    const toolFiles = new Map([
        ['tools/governance/version.json', Buffer.from('{"schemaVersion":1,"version":"9.3.7"}')],
        ['tools/foundation-lock.json', Buffer.from('{"sourceCommit":"' + 'a'.repeat(40) + '"}')],
        ['scripts/community-tools.mjs', Buffer.from('export const fixture = true;')],
    ]);
    const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    for (const [name, bytes] of toolFiles) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        fs.writeFileSync(path.join(directory, name), bytes);
        git('add', name);
    }
    const communityManifest = { schemaVersion: 2,
        tool: { version: '9.3.7', foundationSha256: digest(toolFiles.get('tools/foundation-lock.json')) },
        files: [...JSON.parse(manifest).files, ...[...toolFiles].map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) }))] };
    const independent = Buffer.from(JSON.stringify(communityManifest));
    fs.writeFileSync(path.join(directory, 'tools/submission-files.json'), independent);
    git('add', 'tools/submission-files.json'); git('commit', '-m', 'independent tools fixture');
    assert.equal(runtimeManifest(directory, git('rev-parse', 'HEAD'), 'master'), digest(independent));
    git('switch', '-c', 'other');
    fs.writeFileSync(path.join(directory, 'scripts/submit.mjs'), 'changed'); git('add', 'scripts/submit.mjs'); git('commit', '-m', 'changed');
    const other = git('rev-parse', 'HEAD');
    assert.throws(() => runtimeManifest(directory, other, 'master'));
    assert.throws(() => runtimeManifest(directory, other, 'other'), /RUNTIME_CHANGED/u);
    assert.throws(() => runtimeManifest(directory, '--help', 'master'), /COMMIT_INVALID/u);
});

test('实际签发命令拒绝错误仓库、非主线及非手动事件，且不生成输出', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'community-channel-context-'));
    const output = path.join(folder, 'channel.json');
    const script = fileURLToPath(new URL('../submission-channel.mjs', import.meta.url));
    const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: channel.REPOSITORY,
        GITHUB_REPOSITORY_ID: '1347624983', GITHUB_REPOSITORY_OWNER_ID: '83223374',
        GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch' };
    for (const change of [{ GITHUB_REPOSITORY: 'another/repo' }, { GITHUB_REPOSITORY_ID: '1' },
        { GITHUB_REPOSITORY_OWNER_ID: '1' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'pull_request' }]) {
        assert.throws(() => execFileSync(process.execPath, [script, 'issue', payload.runtimeCommit, output],
            { env: { ...env, ...change }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
        error => error.status === 1 && error.stderr.toString('utf8').includes('CHANNEL_WORKFLOW_INVALID'));
        assert.equal(fs.existsSync(output), false);
    }
});
