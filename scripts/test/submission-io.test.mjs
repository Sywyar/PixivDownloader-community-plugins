import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { root, hash } from '../sdk.mjs';
import { download, publicAddress, httpsUrl } from '../download.mjs';
import { preflight, markerMissing, sourceFacts, git } from '../project.mjs';
import { runBuild } from '../../tools/build-model.mjs';
import { protectedSnapshot, unchanged, readBlob } from '../submission-github.mjs';
import { policy } from '../github.mjs';

const temporary = () => {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    return fs.mkdtempSync(path.join(root, 'target/submission-io-'));
};

test('下载逐跳固定公共 IP，无凭据且校验实际大小与摘要', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicAddress(address), false);
    assert(publicAddress('8.8.8.8'));
    for (const url of ['http://example.org/a', 'https://user:password@example.org/a', 'https://example.org/a#x']) assert.throws(() => httpsUrl(url));
    const folder = temporary();
    const bytes = Buffer.from('streamed bytes');
    let calls = 0;
    const network = {
        proxyForUrl: async () => null,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request: (url, options, callback) => {
            calls++;
            assert.equal(options.agent, false);
            assert.deepEqual(options.headers, { 'Accept-Encoding': 'identity' });
            options.lookup(url.hostname, { all: true }, (error, values) => assert.deepEqual(values, [{ address: '8.8.8.8', family: 4 }]));
            queueMicrotask(() => callback(Object.assign(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), { statusCode: 200, headers: {} })));
            return new EventEmitter();
        },
    };
    const output = path.join(folder, 'exact.bin');
    assert.equal((await download('https://example.org/a', output, bytes.length, { size: bytes.length, sha256: hash(bytes) }, network)).sha256, hash(bytes));
    assert.deepEqual(fs.readFileSync(output), bytes);
    await assert.rejects(download('https://example.org/a', path.join(folder, 'large.bin'), bytes.length - 1, null, network), /DOWNLOAD_SIZE_EXCEEDED/u);
    await assert.rejects(download('https://example.org/a', path.join(folder, 'changed.bin'), bytes.length, { size: bytes.length, sha256: '0'.repeat(64) }, network), /DOWNLOAD_DIGEST_CHANGED/u);
    const before = calls;
    await assert.rejects(download('https://example.org/a', path.join(folder, 'private.bin'), 100, null, { ...network,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /NONPUBLIC_ADDRESS/u);
    assert.equal(calls, before);
    let redirects = 0;
    await assert.rejects(download('https://example.org/a', path.join(folder, 'redirect.bin'), 100, null, { ...network,
        request: (_url, _options, callback) => {
            redirects++;
            queueMicrotask(() => callback(Object.assign(Readable.from([]), { statusCode: 302, headers: { location: 'https://127.0.0.1/private' } })));
            return new EventEmitter();
        } }), /NONPUBLIC_ADDRESS/u);
    assert.equal(redirects, 1);
    assert.equal(fs.existsSync(path.join(folder, 'redirect.bin')), false);
});

test('项目标识必须受 Git 跟踪，错误目录先失败；模型批处理保留真实参数', () => {
    const folder = temporary();
    assert.throws(() => preflight(folder), error => error.message === markerMissing);
    assert.deepEqual(preflight(folder, { allowMissing: true }), { cwd: fs.realpathSync(folder), gitRoot: null, candidates: [] });
    git(folder, 'init');
    const marker = path.join(folder, '.pixivdownloader-plugin-project');
    fs.writeFileSync(marker, 'pixivdownloader-plugin-project-v1\n');
    assert.throws(() => preflight(folder), error => error.message === markerMissing);
    git(folder, 'add', '.pixivdownloader-plugin-project');
    assert.deepEqual(preflight(folder).candidates.map(item => item.projectDir), ['.']);
    fs.appendFileSync(marker, 'invalid');
    assert.throws(() => preflight(folder), /PROJECT_MARKER_INVALID/u);
    assert.throws(() => preflight(folder, { allowMissing: true }), /PROJECT_MARKER_INVALID/u);
    fs.writeFileSync(marker, '\ufeffpixivdownloader-plugin-project-v1\r\n');
    assert.equal(preflight(folder).candidates.length, 1);
    assert.throws(() => sourceFacts(folder), /SOURCE_COMMIT_REQUIRED/u);
    if (process.platform === 'win32') {
        const batch = path.join(folder, 'model args.cmd');
        fs.writeFileSync(batch, '@echo off\r\nnode "%~dp0argv.mjs" %*\r\nexit /b %errorlevel%\r\n');
        fs.writeFileSync(path.join(folder, 'argv.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
        const values = ['-Dtest.name=space value,with#comma', '模型路径', 'set commands += Command.command(new String(Array[Byte](97)))'];
        assert.deepEqual(JSON.parse(runBuild(batch, values, folder)), values);
        fs.writeFileSync(batch, '@exit /b 7\r\n');
        assert.throws(() => runBuild(batch, [], folder), error => error.status === 7);
    }
});

test('下载的 DNS、连接及 TLS 异常转换为安全诊断，期限覆盖 DNS 等待', async () => {
    const folder = temporary();
    const network = { proxyForUrl: async () => null, lookup: async () => [{ address: '8.8.8.8', family: 4 }] };
    for (const [native, code] of [['ETIMEDOUT', 'DOWNLOAD_TIMEOUT'], ['ECONNRESET', 'DOWNLOAD_CONNECTION_RESET'],
        ['ENOTFOUND', 'DOWNLOAD_DNS_FAILED'], ['EAI_AGAIN', 'DOWNLOAD_DNS_FAILED'], ['ECONNREFUSED', 'DOWNLOAD_CONNECTION_FAILED'],
        ['ERR_TLS_CERT_ALTNAME_INVALID', 'DOWNLOAD_TLS_FAILED']]) {
        const error = Object.assign(new Error('sensitive request details'), { code: native });
        await assert.rejects(download('https://example.org/file', path.join(folder, native), 100, null, { ...network,
            request: () => { const request = new EventEmitter(); queueMicrotask(() => request.emit('error', error)); return request; } }),
        error => error.message === code && error.downloadStage === 'CONNECT' && !String(error).includes('sensitive'));
    }
    await assert.rejects(download('https://example.org/file', path.join(folder, 'dns'), 100, null, { ...network,
        lookup: () => new Promise(() => {}), timeout: 20 }), error => error.message === 'DOWNLOAD_TIMEOUT' && error.downloadStage === 'DNS');
});

test('写入前两次身份快照拒绝账号或主线改变', () => {
    let userId = '101';
    let base = 'a'.repeat(40);
    const call = endpoint => endpoint === 'user' ? { type: 'User', id: userId, login: 'actor' }
        : endpoint.endsWith(`/git/ref/heads/${policy.defaultBranch}`) ? { object: { sha: base } }
        : { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
    const expected = protectedSnapshot(call);
    assert.deepEqual(unchanged(expected, call), expected);
    userId = '102';
    assert.throws(() => unchanged(expected, call), /IDENTITY_OR_BASE_CHANGED/u);
    userId = '101'; base = 'b'.repeat(40);
    assert.throws(() => unchanged(expected, call), /IDENTITY_OR_BASE_CHANGED/u);
    assert.throws(() => readBlob('owner/repo', { mode: '120000', type: 'blob', size: 1 }), /GITHUB_FILE_INVALID/u);
});
