import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import channel from '../../tools/submission-channel.cjs';

const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = fs.readFileSync(new URL('../../tools/submit.ps1', import.meta.url), 'utf8');
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function fixture(t, shell, exitCode = 0, options = {}) {
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
    let launcher = source.replaceAll('https://raw.githubusercontent.com/', `${options.tls ? 'https' : 'http'}://bootstrap.invalid/`)
        .replace(/(\$ChannelPublicKey = ')[^']+(')/u, '$1' + spki + '$2');
    if (options.deadline) launcher = launcher.replace('[Threading.CancellationTokenSource]::new(60000)', `[Threading.CancellationTokenSource]::new(${options.deadline})`);
    const script = path.join(folder, 'submit.ps1');
    fs.writeFileSync(script, launcher);
    const runtime = Buffer.from(`console.log(JSON.stringify(process.argv.slice(2))); process.exit(${exitCode}); // ${crypto.randomUUID()}`);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: 'scripts/submit.mjs', size: runtime.length, sha256: hash(runtime) }] }));
    const now = Math.floor(Date.now() / 1000);
    const initial = { schemaVersion: 1, channel: channel.CHANNEL, repository: channel.REPOSITORY, sequence: 1,
        runtimeCommit: crypto.randomBytes(20).toString('hex'), manifestSha256: hash(manifest), issuedAt: now, expiresAt: now + 3600 };
    const state = { scenario: 'success', bytes: channel.signChannel(initial, privateKey), requests: [], faults: new Map(), tunnels: [], tlsDrops: 0, reached: Promise.withResolvers() };
    const handleRequest = (request, response) => {
        const url = new URL(request.url, 'http://bootstrap.invalid');
        if (url.pathname === '/submit.ps1') { response.end(launcher); return; }
        state.requests.push({ url: request.url, headers: request.headers, connection: request.socket.remotePort });
        const faults = state.faults.get(url.pathname.split('/').at(-1));
        const fault = faults?.shift();
        if (fault === 'truncated') {
            response.writeHead(200, { 'Content-Length': runtime.length });
            response.write(runtime.subarray(0, 4));
            setTimeout(() => response.destroy(), 30);
            return;
        }
        if (fault === 'timeout') { response.writeHead(200); response.flushHeaders(); return; }
        if (Number.isInteger(fault)) { response.writeHead(fault); response.end(); return; }
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
    };
    const server = http.createServer(handleRequest);
    if (options.tls) {
        const keyFile = path.join(folder, 'test-key.pem');
        const certFile = path.join(folder, 'test-cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=bootstrap.invalid',
            '-addext', 'subjectAltName=DNS:bootstrap.invalid', '-keyout', keyFile, '-out', certFile], { windowsHide: true, stdio: 'ignore' });
        const origin = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, handleRequest);
        const sockets = new Set();
        for (const listener of [server, origin]) listener.on('connection', socket => {
            sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        });
        origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
        server.on('connect', (request, client, head) => {
            state.tunnels.push({ target: request.url, headers: request.headers });
            if (state.tlsDrops-- > 0) {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                client.once('data', () => client.end());
                return;
            }
            const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head.length) upstream.write(head);
                upstream.pipe(client); client.pipe(upstream);
            });
            sockets.add(upstream);
            upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
            upstream.on('error', () => client.destroy());
            client.on('close', () => upstream.destroy());
            client.on('error', () => upstream.destroy());
        });
        t.after(() => { for (const socket of sockets) socket.destroy(); origin.close(); });
    }
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const proxy = `http://127.0.0.1:${server.address().port}`;
    const localData = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData')"],
        { encoding: 'utf8', windowsHide: true }).trim();
    const cacheBase = path.join(localData, 'PixivDownloader/community-tools');
    const stateFile = path.join(cacheBase, 'channel-v1-' + hash(Buffer.from(spki, 'base64')) + '.json');
    const cachedRuntime = path.join(cacheBase, hash(manifest).slice(0, 16), 'scripts/submit.mjs');
    t.after(() => {
        for (const file of [stateFile, stateFile + '.lock', path.join(cacheBase, hash(manifest) + '.json')]) fs.rmSync(file, { force: true });
        fs.rmSync(path.dirname(path.dirname(cachedRuntime)), { recursive: true, force: true });
        fs.rmSync(folder, { recursive: true, force: true });
    });
    const invoke = async (mode = 'file', directory = project) => {
        const command = `$ProgressPreference = 'SilentlyContinue'; [Globalization.CultureInfo]::CurrentUICulture = 'en-US'; Add-Type -AssemblyName System.Net.Http; `
            + `$proxy = [Net.WebProxy]::new('${proxy}', $false); [Net.WebRequest]::DefaultWebProxy = $proxy; `
            + `if ([Net.Http.HttpClient].GetProperty('DefaultProxy')) { [Net.Http.HttpClient]::DefaultProxy = $proxy }; `
            + (mode === 'file' ? `& ${quote(script)} -ProjectDirectory ${quote(directory)}; exit $LASTEXITCODE`
                : `try { irm '${proxy}/submit.ps1' | iex } catch { [Console]::Error.WriteLine($_.Exception.Message) }; [Console]::WriteLine('CALLER_ALIVE'); exit $LASTEXITCODE`);
        try {
            return { code: 0, ...await promisify(execFile)(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 90000 }) };
        } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    };
    return { ...state, state, folder, project, invoke, stateFile, cachedRuntime, initial, privateKey, runtime };
}

for (const shell of shells) {
    test(`${shell} 真实 CONNECT 中的 TLS 提前结束会重试，证书验证失败立即阻断`, async t => {
        for (const drops of [0, 2]) {
            const f = await fixture(t, shell, 0, { tls: true });
            f.state.tlsDrops = drops;
            const result = await f.invoke('pipeline');
            assert.equal(result.code, 1);
            assert(result.stdout.includes('CALLER_ALIVE'));
            assert(!result.stdout.includes(f.project));
            assert.match(result.stderr, /TLS_REJECTED/u);
            assert.equal(f.state.tunnels.length, drops + 1);
            assert.equal(f.state.requests.length, 0);
            assert(!fs.existsSync(f.stateFile));
            for (const tunnel of f.state.tunnels) {
                assert.equal(tunnel.target, 'bootstrap.invalid:443');
                assert.equal(tunnel.headers.authorization, undefined);
                assert.equal(tunnel.headers['proxy-authorization'], undefined);
            }
            if (drops) assert.match(result.stderr, /TLS_INTERRUPTED|TRANSFER_INTERRUPTED|WEB_ReceiveFailure|WEB_ConnectionClosed/u);
        }
    });

    test(`${shell} 连续下载复用连接，渠道、清单和文件的短暂失败恢复后执行完整字节`, async t => {
        const healthy = await fixture(t, shell);
        const ready = await healthy.invoke();
        assert.equal(ready.code, 0, ready.stderr);
        assert.equal(new Set(healthy.state.requests.map(request => request.connection)).size, 1);
        const f = await fixture(t, shell);
        f.state.faults.set('submission-channel.json', [503]);
        f.state.faults.set('submission-files.json', [502]);
        f.state.faults.set('submit.mjs', ['truncated']);
        const result = await f.invoke('pipeline');
        assert.equal(result.code, 0, result.stderr);
        assert(result.stdout.includes('CALLER_ALIVE'));
        assert.deepEqual(fs.readFileSync(f.cachedRuntime), f.runtime);
        for (const name of ['submission-channel.json', 'submission-files.json', 'submit.mjs']) {
            assert.equal(f.state.requests.filter(request => request.url.endsWith('/' + name)).length, 2);
            assert(result.stderr.includes(name), result.stderr);
        }
        assert(!fs.readdirSync(path.dirname(f.cachedRuntime)).some(name => name.endsWith('.tmp')));
    });

    test(`${shell} 持续故障有重试上限，权限拒绝不重试且错误保留文件与阶段`, async t => {
        for (const status of [503, 403]) {
            const f = await fixture(t, shell);
            f.state.faults.set('submit.mjs', Array(8).fill(status));
            const result = await f.invoke('pipeline');
            assert.equal(result.code, 1);
            assert(!result.stdout.includes(f.project));
            assert.equal(f.state.requests.filter(request => request.url.endsWith('/submit.mjs')).length, status === 503 ? 3 : 1);
            for (const value of ['BOOTSTRAP_DOWNLOAD_FAILED', 'scripts/submit.mjs', 'headers', `HTTP_${status}`]) assert(result.stderr.includes(value), result.stderr);
            assert(!fs.existsSync(f.cachedRuntime));
            assert(!fs.readdirSync(path.dirname(f.cachedRuntime)).some(name => name.endsWith('.tmp')));
        }
    });

    test(`${shell} 退避与响应体读取共用截止时间，超时后保留已验证缓存`, async t => {
        const f = await fixture(t, shell, 0, { deadline: 1800 });
        f.state.faults.set('submit.mjs', [503, 'timeout']);
        const start = Date.now();
        const result = await f.invoke();
        assert.equal(result.code, 1);
        assert.match(result.stderr, /TIMEOUT/u);
        assert(Date.now() - start < 8000);
        assert.equal(f.state.requests.filter(request => request.url.endsWith('/submit.mjs')).length, 2);
        assert(!fs.existsSync(f.cachedRuntime));
        assert.deepEqual(fs.readFileSync(f.stateFile), f.state.bytes);
    });

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
