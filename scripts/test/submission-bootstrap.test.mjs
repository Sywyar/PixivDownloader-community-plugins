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
import { root, hash } from '../sdk.mjs';
import { git, markerMissing } from '../project.mjs';

test('PowerShell 5.1 与 7 的真实固定入口保留 Unicode 参数及退出码，拒绝错误目录和缓存篡改',
    { skip: process.platform !== 'win32' }, async t => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-submit-'));
        const tools = path.join(folder, 'tools');
        const project = path.join(folder, '工程 space,#');
        fs.mkdirSync(tools); fs.mkdirSync(project); fs.mkdirSync(path.join(folder, 'scripts'));
        git(project, 'init');
        fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), '\ufeffpixivdownloader-plugin-project-v1\r\n');
        git(project, 'add', '.pixivdownloader-plugin-project');
        const runtime = Buffer.from('console.log(JSON.stringify(process.argv.slice(2))); process.exit(7); // ' + crypto.randomUUID());
        fs.writeFileSync(path.join(folder, 'scripts/submit.mjs'), runtime);
        const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{ path: 'scripts/submit.mjs', size: runtime.length, sha256: hash(runtime) }] }));
        fs.writeFileSync(path.join(tools, 'submission-files.json'), manifest);
        const launcher = fs.readFileSync(path.join(root, 'tools/submit.ps1'), 'utf8')
            .replace(/(\$RuntimeCommit = ')[a-f0-9]{40}(')/u, '$1' + 'a'.repeat(40) + '$2')
            .replace(/(\$ManifestSha256 = ')[a-f0-9]{64}(')/u, '$1' + hash(manifest) + '$2');
        const script = path.join(tools, 'submit.ps1');
        fs.writeFileSync(script, launcher, 'utf8');
        const cache = path.join(process.env.LOCALAPPDATA, 'PixivDownloader/community-tools', hash(manifest).slice(0, 16));
        const server = http.createServer((request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(launcher);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        t.after(() => server.close());
        const url = `http://127.0.0.1:${server.address().port}/submit.ps1`;
        for (const shell of ['powershell.exe', 'pwsh']) {
            const invoke = directory => execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-ProjectDirectory', directory],
                { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
            assert.throws(() => invoke(folder), error => error.status === 1 && error.stderr.trim() === markerMissing);
            assert.throws(() => invoke(project), error => {
                assert.equal(error.status, 7, error.stderr);
                assert.equal(error.stderr, '');
                assert.deepEqual(JSON.parse(error.stdout.trim()), [project]);
                return true;
            });
            fs.writeFileSync(path.join(cache, 'scripts/submit.mjs'), 'throw new Error("unexpected execution");');
            assert.throws(() => invoke(project), error => error.status === 1 && error.stderr.includes('BOOTSTRAP_FILE_CHANGED'));
            // 只恢复本测试创建并记录的缓存文件，不删除既有缓存。
            fs.writeFileSync(path.join(cache, 'scripts/submit.mjs'), runtime);
            const invokePipeline = (directory, handleFailure = true) => {
                const command = `$ProgressPreference = 'SilentlyContinue'; ` + (handleFailure
                    ? `try { irm '${url}' | iex } catch { [Console]::Error.WriteLine($_.Exception.Message) }; [Console]::WriteLine('CALLER_ALIVE'); exit $LASTEXITCODE`
                    : `irm '${url}' | iex`);
                return promisify(execFile)(shell,
                    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                    { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
            };
            await assert.rejects(invokePipeline(project), error => {
                assert.equal(error.code, 7, error.stderr);
                assert(error.stderr.includes('SUBMISSION_FAILED: 7'));
                const lines = error.stdout.trim().split(/\r?\n/u);
                assert.deepEqual(JSON.parse(lines[0]), [project]);
                assert.equal(lines[1], 'CALLER_ALIVE');
                return true;
            });
            await assert.rejects(invokePipeline(folder), error => error.code === 1 && error.stderr.trim() === markerMissing
                && error.stdout.trim() === 'CALLER_ALIVE');
            await assert.rejects(invokePipeline(project, false), error => error.code === 1 && error.stderr.includes('SUBMISSION_FAILED: 7'));
            await assert.rejects(invokePipeline(folder, false), error => error.code === 1 && error.stderr.includes(markerMissing));
        }
    });

test('空缓存入口使用进程默认代理下载并验摘要，下载失败在文件和管道入口均返回失败',
    { skip: process.platform !== 'win32', timeout: 180_000 }, async t => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-submit-proxy-'));
        const project = path.join(folder, '工程 space');
        fs.mkdirSync(project);
        git(project, 'init');
        fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
        git(project, 'add', '.pixivdownloader-plugin-project');
        const source = fs.readFileSync(path.join(root, 'tools/submit.ps1'), 'utf8');
        let launcher, manifest, runtime, scenario;
        const requests = [];
        const proxy = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/submit.ps1') {
                response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end(launcher);
                return;
            }
            requests.push({ url: request.url, headers: request.headers });
            if (scenario === 'redirect') {
                response.writeHead(302, { Location: 'http://redirect.invalid/changed' });
                response.end();
            } else if (url.pathname.endsWith('/tools/submission-files.json')) {
                response.end(manifest);
            } else if (url.pathname.endsWith('/scripts/submit.mjs')) {
                const body = Buffer.from(runtime);
                if (scenario === 'tampered') body[0] ^= 1;
                response.end(body);
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        proxy.listen(0, '127.0.0.1');
        await once(proxy, 'listening');
        t.after(() => { proxy.closeAllConnections(); proxy.close(); });
        const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
        const script = path.join(folder, 'submit.ps1');
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        for (const shell of ['powershell.exe', 'pwsh']) {
            for (const mode of ['file', 'pipeline']) {
                for (scenario of ['success', 'tampered', 'redirect']) {
                    const token = crypto.randomUUID();
                    runtime = Buffer.from(`console.log('${token}');`);
                    manifest = Buffer.from(JSON.stringify({ schemaVersion: 1,
                        files: [{ path: 'scripts/submit.mjs', size: runtime.length, sha256: hash(runtime) }] }));
                    const digest = hash(manifest);
                    const cacheRoot = path.join(process.env.LOCALAPPDATA, 'PixivDownloader/community-tools');
                    assert.equal(fs.existsSync(path.join(cacheRoot, digest + '.json')), false);
                    assert.equal(fs.existsSync(path.join(cacheRoot, digest.slice(0, 16))), false);
                    // 只将固定源换成测试专用 HTTP 主机；完整入口与下载器照常执行，代理设置仅存在于子进程。
                    launcher = source.replaceAll('https://raw.githubusercontent.com/', 'http://bootstrap.invalid/')
                        .replace(/(\$ManifestSha256 = ')[a-f0-9]{64}(')/u, '$1' + digest + '$2');
                    fs.writeFileSync(script, launcher, 'utf8');
                    requests.length = 0;
                    const command = `$ProgressPreference = 'SilentlyContinue'; Add-Type -AssemblyName System.Net.Http; `
                        + `$proxy = [Net.WebProxy]::new('${proxyUrl}', $false); [Net.WebRequest]::DefaultWebProxy = $proxy; `
                        + `if ([Net.Http.HttpClient].GetProperty('DefaultProxy')) { [Net.Http.HttpClient]::DefaultProxy = $proxy }; `
                        + (mode === 'file' ? `& ${quote(script)} -ProjectDirectory ${quote(project)}; exit $LASTEXITCODE`
                            : `irm '${proxyUrl}/submit.ps1' | iex`);
                    const result = promisify(execFile)(shell,
                        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                        { cwd: project, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
                    if (scenario === 'success') {
                        const output = await result;
                        assert.equal(output.stdout.trim(), token);
                        assert.equal(output.stderr, '');
                        assert.equal(requests.length, 2);
                        assert.deepEqual(fs.readFileSync(path.join(cacheRoot, digest.slice(0, 16), 'scripts/submit.mjs')), runtime);
                    } else {
                        await assert.rejects(result, error => error.code === 1 && !error.stdout.includes(token)
                            && error.stderr.includes(scenario === 'tampered' ? 'BOOTSTRAP_FILE_CHANGED' : 'BOOTSTRAP_DOWNLOAD_FAILED'));
                        assert.equal(requests.length, scenario === 'redirect' ? 1 : 2);
                    }
                    for (const request of requests) {
                        assert(request.url.startsWith('http://bootstrap.invalid/'));
                        assert.equal(request.headers.authorization, undefined);
                        assert.equal(request.headers.cookie, undefined);
                    }
                }
            }
        }
    });
