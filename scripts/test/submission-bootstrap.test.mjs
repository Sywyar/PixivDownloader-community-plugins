import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import channel from '../../tools/submission-channel.cjs';

const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(new URL('../../tools/submit.ps1', import.meta.url), 'utf8');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function fixture(t, shell, exitCode = 0) {
    // Windows 临时目录可能使用短路径；与 Git 返回的真实工程路径保持一致。
    const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'community-bootstrap-')));
    const project = path.join(folder, '工程 space,#');
    fs.mkdirSync(project);
    for (const args of [['init'], ['add', '.pixivdownloader-plugin-project']]) {
        if (args[0] === 'add') fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), '\ufeffpixivdownloader-plugin-project-v1\r\n');
        execFileSync('git', ['-C', project, ...args], { windowsHide: true, stdio: 'ignore' });
    }
    const keys = crypto.generateKeyPairSync('ed25519');
    const spki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const launcher = source.replaceAll('https://raw.githubusercontent.com/', 'http://bootstrap.invalid/')
        .replace(/(\$ChannelPublicKey = ')[^']+(')/u, '$1' + spki + '$2');
    const script = path.join(folder, 'submit.ps1');
    fs.writeFileSync(script, launcher);
    const runtime = Buffer.from(`console.log(JSON.stringify(process.argv.slice(2))); process.exit(${exitCode}); // ${crypto.randomUUID()}`);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: 'scripts/submit.mjs', size: runtime.length, sha256: hash(runtime) }] }));
    const now = Math.floor(Date.now() / 1000);
    const initial = { schemaVersion: 1, channel: channel.CHANNEL, repository: channel.REPOSITORY, sequence: 1,
        runtimeCommit: crypto.randomBytes(20).toString('hex'), manifestSha256: hash(manifest), issuedAt: now, expiresAt: now + 3600 };
    const state = { scenario: 'success', bytes: channel.signChannel(initial, privateKey), requests: [], reached: Promise.withResolvers() };
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://bootstrap.invalid');
        if (url.pathname === '/submit.ps1') { response.end(launcher); return; }
        state.requests.push({ url: request.url, headers: request.headers });
        if (state.scenario === 'redirect') { response.writeHead(302, { Location: 'http://elsewhere.invalid/changed' }); response.end(); return; }
        if (state.scenario === 'unavailable') { response.writeHead(503); response.end(); return; }
        if (url.pathname.endsWith('/tools/submission-channel.json')) {
            if (state.pauseChannel) { state.release = () => response.end(state.bytes); state.reached.resolve(); }
            else response.end(state.bytes);
            return;
        }
        if (url.pathname.endsWith('/tools/submission-files.json')) { response.end(state.scenario === 'manifest-tamper' ? Buffer.from('{}') : manifest); return; }
        if (url.pathname.endsWith('/scripts/submit.mjs')) {
            const bytes = Buffer.from(runtime);
            if (state.scenario === 'file-tamper') bytes[0] ^= 1;
            response.end(bytes); return;
        }
        response.writeHead(404); response.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const proxy = `http://127.0.0.1:${server.address().port}`;
    const localData = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData')"],
        { encoding: 'utf8', windowsHide: true }).trim();
    const cacheBase = path.join(localData, 'PixivDownloader/community-tools');
    const stateFile = path.join(cacheBase, 'channel-v1-' + hash(Buffer.from(spki, 'base64')) + '.json');
    const cachedRuntime = path.join(cacheBase, hash(manifest).slice(0, 16), 'scripts/submit.mjs');
    const invoke = async (mode = 'file', directory = project) => {
        const command = `$ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.Net.Http; `
            + `$proxy = [Net.WebProxy]::new('${proxy}', $false); [Net.WebRequest]::DefaultWebProxy = $proxy; `
            + `if ([Net.Http.HttpClient].GetProperty('DefaultProxy')) { [Net.Http.HttpClient]::DefaultProxy = $proxy }; `
            + (mode === 'file' ? `& ${quote(script)} -ProjectDirectory ${quote(directory)}; exit $LASTEXITCODE`
                : `try { irm '${proxy}/submit.ps1' | iex } catch { [Console]::Error.WriteLine($_.Exception.Message) }; [Console]::WriteLine('CALLER_ALIVE'); exit $LASTEXITCODE`);
        try {
            return { code: 0, ...await promisify(execFile)(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60000 }) };
        } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    };
    return { ...state, state, folder, project, invoke, stateFile, cachedRuntime, initial, privateKey, runtime };
}

for (const shell of shells) {
    test(`${shell} 的文件与管道入口校验实际下载并保留 Unicode 参数、退出码和调用终端`, async t => {
        const f = await fixture(t, shell, 7);
        const invalid = await f.invoke('file', f.folder);
        assert.equal(invalid.code, 1); assert.equal(f.state.requests.length, 0);
        for (const mode of ['file', 'pipeline']) {
            const result = await f.invoke(mode);
            assert.equal(result.code, 7, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u)[0]), [f.project]);
            if (mode === 'pipeline') assert(result.stdout.includes('CALLER_ALIVE'));
        }
        assert.deepEqual(fs.readFileSync(f.stateFile), f.state.bytes);
        assert.deepEqual(fs.readFileSync(f.cachedRuntime), f.runtime);
        for (const request of f.state.requests) {
            assert(request.url.startsWith('http://bootstrap.invalid/'));
            assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
        }
        fs.writeFileSync(f.cachedRuntime, 'throw new Error("must not run");');
        const tampered = await f.invoke();
        assert.equal(tampered.code, 1); assert(tampered.stderr.includes('BOOTSTRAP_FILE_CHANGED'), tampered.stderr);
    });

    test(`${shell} 拒绝篡改与过期清单，已有缓存仍阻止回退、序号冲突和下载失败`, async t => {
        const f = await fixture(t, shell);
        const first = await f.invoke(); assert.equal(first.code, 0, first.stderr);
        const original = f.state.bytes;
        f.state.bytes = channel.signChannel({ ...f.initial, sequence: 2 }, f.privateKey);
        const second = await f.invoke('pipeline'); assert.equal(second.code, 0, second.stderr);
        const accepted = f.state.bytes;
        for (const [bytes, reason] of [
            [original, 'ROLLBACK'],
            [channel.signChannel({ ...f.initial, sequence: 2, expiresAt: f.initial.expiresAt + 1 }, f.privateKey), 'SEQUENCE_CONFLICT'],
            [channel.signChannel({ ...f.initial, sequence: 3, issuedAt: f.initial.issuedAt - 100, expiresAt: f.initial.issuedAt - 1 }, f.privateKey), 'EXPIRED'],
            [Buffer.from(JSON.stringify({ ...JSON.parse(accepted), signature: Buffer.alloc(64).toString('base64') })), 'SIGNATURE_INVALID'],
            [Buffer.alloc(channel.MAX_BYTES + 1), 'SIZE_EXCEEDED'],
        ]) {
            f.state.bytes = bytes;
            const result = await f.invoke('pipeline');
            assert.equal(result.code, 1); assert(result.stderr.includes(reason), result.stderr);
            assert(!result.stdout.includes(f.project));
            assert.deepEqual(fs.readFileSync(f.stateFile), accepted);
        }
        f.state.bytes = accepted;
        for (const scenario of ['redirect', 'unavailable']) {
            f.state.scenario = scenario;
            const result = await f.invoke();
            assert.equal(result.code, 1); assert(result.stderr.includes('BOOTSTRAP_DOWNLOAD_FAILED'), result.stderr);
            assert.equal(result.stdout, '');
        }
        f.state.scenario = 'success';
        fs.writeFileSync(f.stateFile, '{}');
        const corruptState = await f.invoke();
        assert.equal(corruptState.code, 1); assert.equal(corruptState.stdout, '');
    });

    test(`${shell} 空缓存时拒绝工具清单和执行文件的摘要变化`, async t => {
        for (const scenario of ['manifest-tamper', 'file-tamper']) {
            const f = await fixture(t, shell);
            f.state.scenario = scenario;
            const result = await f.invoke('pipeline');
            assert.equal(result.code, 1); assert(!result.stdout.includes(f.project));
            assert(result.stderr.includes(scenario === 'manifest-tamper' ? 'BOOTSTRAP_MANIFEST_CHANGED' : 'BOOTSTRAP_FILE_CHANGED'), result.stderr);
        }
    });

    test(`${shell} 并发启动不能覆盖正在推进的签名清单状态`, async t => {
        const f = await fixture(t, shell);
        f.state.pauseChannel = true;
        const first = f.invoke();
        await f.state.reached.promise;
        try {
            const second = await f.invoke('pipeline');
            assert.equal(second.code, 1); assert(second.stderr.includes('BOOTSTRAP_CHANNEL_BUSY'), second.stderr);
        } finally { f.state.release(); }
        const result = await first;
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(fs.readFileSync(f.stateFile), f.state.bytes);
    });
}
