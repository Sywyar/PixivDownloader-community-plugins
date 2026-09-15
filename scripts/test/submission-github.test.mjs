import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { githubRequest } from '../submission-github.mjs';

test('实际子进程读取在临时 HTTP 失败后恢复，写入和权限失败不自动重放', async t => {
    const server = new Worker(`const { parentPort } = require('node:worker_threads');
        const counts = new Map();
        require('node:http').createServer((req, res) => {
            const count = (counts.get(req.url) || 0) + 1; counts.set(req.url, count);
            res.statusCode = req.url === '/denied' ? 403 : req.url === '/read' && count > 2 ? 200 : 503;
            res.end(JSON.stringify({ count, text: 'fixture' }));
        }).listen(0, '127.0.0.1', function() { parentPort.postMessage(this.address().port); });`, { eval: true });
    t.after(() => server.terminate());
    const [port] = await once(server, 'message');
    const client = `const r = await fetch(process.argv[1], { method: process.argv[2] });
        process.stdout.write(await r.text());
        if (!r.ok) { process.stderr.write('gh: fixture (HTTP ' + r.status + ')'); process.exitCode = 1; }`;
    const request = (route, method = 'GET') => githubRequest(timeout => execFileSync(process.execPath,
        ['--input-type=module', '-e', client, 'http://127.0.0.1:' + port + route, method],
        { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), { method });
    assert.deepEqual(JSON.parse(request('/read')), { count: 3, text: 'fixture' });
    for (const [route, method, status] of [['/write', 'POST', 503], ['/denied', 'GET', 403]]) {
        assert.throws(() => request(route, method), error => error.github && error.status === status && error.attempts === 1
            && !JSON.stringify(error).includes('fixture'));
    }
});

test('读取重试共用截止时间并保留安全诊断，超限与取消直接传播', () => {
    let time = 0; const timeouts = []; const waits = [];
    const native = () => Object.assign(new Error('token=private-output'), { stderr: 'signed-url?secret (HTTP 503)' });
    assert.throws(() => githubRequest(timeout => { timeouts.push(timeout); time += 100; throw native(); },
        { timeout: 2500, now: () => time, wait: ms => { waits.push(ms); time += ms; } }), error => {
        assert.equal(error.message, 'GITHUB_REQUEST_FAILED'); assert.equal(error.attempts, 2);
        assert(!JSON.stringify(error).includes('secret')); return true;
    });
    assert.deepEqual(timeouts, [2500, 1400]); assert.deepEqual(waits, [1000]);
    time = 0; let calls = 0;
    assert.throws(() => githubRequest(() => { calls++; throw native(); },
        { timeout: 2500, now: () => time, wait: () => { time = 5000; } }), { message: 'GITHUB_TIMEOUT', attempts: 1 });
    assert.equal(calls, 1);
    for (const [code, message] of [['ENOBUFS', 'INPUT_SIZE_EXCEEDED'], ['ENOENT', 'GITHUB_CLI_REQUIRED']]) {
        assert.throws(() => githubRequest(() => { throw Object.assign(native(), { code }); }), { message });
    }
    assert.throws(() => githubRequest(() => { throw new Error('CANCELLED'); }), /CANCELLED/u);
    let attempts = 0;
    assert.throws(() => githubRequest(() => { attempts++; throw new Error('unknown transport or TLS failure'); }), /GITHUB_REQUEST_FAILED/u);
    assert.equal(attempts, 1);
});
