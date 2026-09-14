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
