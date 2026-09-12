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
            const command = `$ProgressPreference = 'SilentlyContinue'; irm '${url}' | iex; [Console]::WriteLine('CALLER_ALIVE'); exit $LASTEXITCODE`;
            const invokePipeline = directory => promisify(execFile)(shell,
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
                { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
            await assert.rejects(invokePipeline(project), error => {
                assert.equal(error.code, 7, error.stderr);
                assert.equal(error.stderr, '');
                const lines = error.stdout.trim().split(/\r?\n/u);
                assert.deepEqual(JSON.parse(lines[0]), [project]);
                assert.equal(lines[1], 'CALLER_ALIVE');
                return true;
            });
            await assert.rejects(invokePipeline(folder), error => error.code === 1 && error.stderr.trim() === markerMissing
                && error.stdout.trim() === 'CALLER_ALIVE');
        }
    });
