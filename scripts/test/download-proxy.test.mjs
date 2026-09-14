import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { bypassProxy, proxyUrl, resolveProxy } from '../download-proxy.mjs';
import { root, hash } from '../sdk.mjs';

test('代理选择保留环境变量优先级、目标绕过及 Windows 系统设置', async () => {
    const url = new URL('https://download.example.org/file');
    const signal = new AbortController().signal;
    let calls = 0;
    const system = async () => { calls++; return 'http://system.example:8080'; };
    const select = env => resolveProxy(url, signal, { env, platform: 'win32', system });
    assert.equal((await select({})).hostname, 'system.example');
    assert.equal((await select({ HTTPS_PROXY: 'http://upper.example', https_proxy: 'https://lower.example' })).hostname, 'lower.example');
    assert.equal(await select({ HTTPS_PROXY: '' }), null);
    assert.equal(await select({ HTTPS_PROXY: 'http://proxy.example', NO_PROXY: '.example.org' }), null);
    assert.equal((await select({ ALL_PROXY: 'http://all.example' })).hostname, 'all.example');
    assert.equal(calls, 1);
    assert.equal(await resolveProxy(url, signal, { env: {}, platform: 'linux', system }), null);
    for (const entry of ['*', '.example.org', '*.example.org', 'download.example.org', 'download.example.org:443']) assert(bypassProxy(url, entry));
    for (const entry of ['example.org', '.other.org', 'download.example.org:444']) assert(!bypassProxy(url, entry));
    assert(bypassProxy(new URL('https://8.8.8.8'), '8.8.8.1-8.8.8.9'));
    assert(bypassProxy(new URL('https://[2001:4860:4860::8888]'), '[2001:4860:4860::8888]:443'));
    for (const value of ['socks5://proxy.example', 'http://proxy.example/path', 'http://proxy.example/#x', 'http://bad%escape@proxy.example']) {
        assert.throws(() => proxyUrl(value), /DOWNLOAD_PROXY_INVALID/u);
    }
});

test('真实 HTTPS 代理固定 CONNECT 地址、验证 TLS、下载与复核字节并传播失败', { timeout: 120000 }, async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'community-download-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const certificate = path.join(folder, 'certificate.pem');
    const privateKey = path.join(folder, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=github.com',
        '-addext', 'subjectAltName=DNS:github.com,DNS:assets.example.org,IP:127.0.0.1', '-keyout', privateKey, '-out', certificate],
    { windowsHide: true, stdio: 'ignore' });
    const bytes = Buffer.from('package and source bytes');
    const expected = { size: bytes.length, sha256: hash(bytes) };
    const requests = [];
    const connections = [];
    const sockets = new Set();
    const origin = https.createServer({ key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) }, (req, res) => {
        requests.push({ url: req.url, headers: req.headers, servername: req.socket.servername });
        if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://assets.example.org/package' }); res.end(); }
        else if (req.url === '/private') { res.writeHead(302, { Location: 'https://127.0.0.1/forbidden' }); res.end(); }
        else if (req.url === '/credentials') { res.writeHead(302, { Location: 'https://user:password@assets.example.org/package' }); res.end(); }
        else if (req.url === '/http') { res.writeHead(302, { Location: 'http://assets.example.org/package' }); res.end(); }
        else if (req.url === '/wrong-host') { res.writeHead(302, { Location: 'https://wrong.example.org/package' }); res.end(); }
        else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
        else if (req.url === '/reset') req.socket.destroy();
        else if (req.url === '/body-timeout') { res.writeHead(200); res.flushHeaders(); }
        else if (req.url === '/unavailable') { res.writeHead(503); res.end(); }
        else { res.setHeader('Content-Length', bytes.length); res.end(bytes); }
    });
    let behavior = 'success';
    const proxy = http.createServer();
    const secureProxy = https.createServer({ key: fs.readFileSync(privateKey), cert: fs.readFileSync(certificate) });
    const connect = (req, client, head) => {
        connections.push({ destination: req.url, headers: req.headers });
        if (behavior === 'timeout') return;
        if (behavior === 'auth') { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
        assert.match(req.url, /^8\.8\.8\.[89]:443$/u);
        const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            upstream.pipe(client); client.pipe(upstream);
        });
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    };
    proxy.on('connect', connect); secureProxy.on('connect', connect);
    for (const server of [origin, proxy, secureProxy]) {
        server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
    }
    t.after(() => { for (const socket of sockets) socket.destroy(); origin.close(); proxy.close(); secureProxy.close(); });
    const proxyAddress = `http://proxy-user:proxy-password@127.0.0.1:${proxy.address().port}`;
    const runner = path.join(folder, 'download.mjs');
    fs.writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { download } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/download.mjs')).href)};
import { sourceArchive } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/submission-check.mjs')).href)};
const config = JSON.parse(process.env.DOWNLOAD_TEST);
const options = { timeout: config.timeout ?? 10000, lookup: async host => [{ address: host === 'assets.example.org' ? '8.8.8.9' : '8.8.8.8', family: 4 }] };
if (config.direct) options.request = (url, opts, callback) => https.get(url, { ...opts, port: config.port, lookup: (_host, lookupOptions, done) => lookupOptions.all ? done(null, [{address:'127.0.0.1',family:4}]) : done(null,'127.0.0.1',4) }, callback);
try {
    for (const [i, route] of config.routes.entries()) {
        const file = path.join(config.folder, config.id + '-' + i);
        await download('https://github.com/' + route, file, config.maximum ?? 1024, config.expected, options);
        if (!fs.readFileSync(file).equals(Buffer.from(config.bytes))) throw new Error('WRONG_BYTES');
    }
    if (config.source) {
        const commit = 'a'.repeat(40);
        const source = {repository:'https://github.com/example/plugin',commit,archive:{url:'https://github.com/example/plugin/archive/'+commit+'.zip',...config.expected}};
        await sourceArchive({workspace:config.folder,invoke:input=>input.command==='limits'?{maxArchiveBytes:1024}:{}}, source, '.',
            endpoint=>endpoint.includes('/commits/')?{sha:commit}:{id:123,full_name:'example/plugin',owner:{id:123}},
            (url,file,maximum,expected)=>download(url,file,maximum,expected,options));
    }
    console.log(JSON.stringify({ok:true}));
} catch(error) { console.log(JSON.stringify({code:error.message,stage:error.downloadStage})); process.exitCode=1; }
`, 'utf8');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/proxy|TOKEN|SECRET|PRIVATE_KEY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS/iu.test(key)));
    let sequence = 0;
    const run = async (config = {}, shell) => {
        const variables = { ...env, HTTPS_PROXY: proxyAddress, NODE_EXTRA_CA_CERTS: certificate,
            DOWNLOAD_TEST: JSON.stringify({ id: ++sequence, folder, routes: ['redirect', 'source', 'package'], expected, bytes: [...bytes], ...config }) };
        if (config.direct) variables.NO_PROXY = '*';
        if (config.secureProxy) variables.HTTPS_PROXY = `https://proxy-user:proxy-password@127.0.0.1:${secureProxy.address().port}`;
        if (config.untrusted) delete variables.NODE_EXTRA_CA_CERTS;
        try {
            const program = shell ?? process.execPath;
            const args = shell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '& node $env:DOWNLOAD_RUNNER; exit $LASTEXITCODE'] : [runner];
            const result = await promisify(execFile)(program, args, { env: { ...variables, DOWNLOAD_RUNNER: runner }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
            return JSON.parse(result.stdout.trim());
        } catch (error) { assert(error.stdout, error.stderr || error.message); return JSON.parse(error.stdout.trim()); }
    };
    assert.deepEqual(await run({ source: true }), { ok: true });
    assert.deepEqual(await run({ secureProxy: true }), { ok: true });
    const count = connections.length;
    assert.deepEqual(await run({ direct: true, port: origin.address().port, routes: ['package'] }), { ok: true });
    assert.equal(connections.length, count);
    for (const shell of process.platform === 'win32' ? ['powershell.exe', 'pwsh'] : ['pwsh']) assert.deepEqual(await run({}, shell), { ok: true });
    for (const req of requests) {
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
        assert.equal(req.headers['proxy-authorization'], undefined);
        assert(['github.com', 'assets.example.org'].includes(req.servername));
        assert(['github.com', 'assets.example.org'].includes(new URL('https://' + req.headers.host).hostname));
    }
    assert(connections.some(value => value.destination === '8.8.8.9:443'));
    for (const req of connections) {
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
        assert.equal(req.headers['proxy-authorization'], 'Basic ' + Buffer.from('proxy-user:proxy-password').toString('base64'));
    }
    for (const [config, code] of [
        [{ expected: { ...expected, sha256: '0'.repeat(64) } }, 'DOWNLOAD_DIGEST_CHANGED'],
        [{ maximum: bytes.length - 1 }, 'DOWNLOAD_SIZE_EXCEEDED'],
        [{ routes: ['private'] }, 'NONPUBLIC_ADDRESS'],
        [{ routes: ['credentials'] }, 'HTTPS_URL_INVALID'],
        [{ routes: ['http'] }, 'HTTPS_URL_INVALID'],
        [{ routes: ['loop'] }, 'DOWNLOAD_REDIRECT_LIMIT'],
        [{ routes: ['unavailable'] }, 'DOWNLOAD_RESPONSE_INVALID'],
        [{ routes: ['reset'] }, 'DOWNLOAD_CONNECTION_RESET'],
        [{ untrusted: true }, 'DOWNLOAD_TLS_FAILED'],
        [{ routes: ['wrong-host'] }, 'DOWNLOAD_TLS_FAILED'],
        [{ routes: ['body-timeout'], timeout: 300 }, 'DOWNLOAD_TIMEOUT'],
    ]) assert.equal((await run(config)).code, code);
    behavior = 'auth';
    assert.equal((await run()).code, 'DOWNLOAD_PROXY_AUTH_REQUIRED');
    behavior = 'timeout';
    assert.equal((await run({ timeout: 300 })).code, 'DOWNLOAD_TIMEOUT');
});
