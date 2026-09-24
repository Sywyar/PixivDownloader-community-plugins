import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { githubRequest, protectedSnapshot } from '../submission-github.mjs';
import { policy } from '../github.mjs';
import { runWizard } from '../submit.mjs';
import { requestRecovery, retryStep } from '../submission-retry.mjs';
import { observe } from '../submission-progress.mjs';
import { gitFailure } from '../submission-errors.mjs';
import { git } from '../project.mjs';
import { failureCode, locales } from '../submission-ui.mjs';
import { errors } from '../submission-messages.mjs';

test('原生错误按认证、权限、传输和本地执行分类，确定性拒绝不进入恢复循环', async t => {
    const cases = [
        [{ code: 'ENOENT' }, 'GITHUB_CLI_REQUIRED', false, false],
        [{ code: 'EPERM' }, 'GITHUB_CLI_ACCESS_DENIED', false, false],
        [{ code: 'ENOBUFS', stderr: '(HTTP 503)' }, 'INPUT_SIZE_EXCEEDED', false, false],
        [{ status: 4 }, 'GITHUB_AUTH_REQUIRED', false, true],
        [{ status: 2 }, 'CANCELLED', false, false],
        [{ stderr: '(HTTP 401)' }, 'GITHUB_AUTH_INVALID', false, true],
        [{ stderr: '(HTTP 403)' }, 'GITHUB_ACCESS_DENIED', false, true],
        [{ stderr: 'API rate limit exceeded (HTTP 403)' }, 'GITHUB_RATE_LIMITED', false, true],
        [{ stderr: '(HTTP 404)' }, 'GITHUB_NOT_FOUND', false, false],
        [{ stderr: '(HTTP 407)' }, 'GITHUB_PROXY_AUTH_REQUIRED', false, true],
        [{ stderr: '(HTTP 409)' }, 'GITHUB_CONFLICT', false, false],
        [{ stderr: '(HTTP 422)' }, 'GITHUB_INPUT_REJECTED', false, false],
        [{ stderr: '(HTTP 429)' }, 'GITHUB_RATE_LIMITED', false, true],
        [{ stderr: 'x509: certificate signed by unknown authority' }, 'GITHUB_TLS_FAILED', false, false],
        [{ code: 'CERT_HAS_EXPIRED' }, 'GITHUB_TLS_FAILED', false, false],
        [{ stderr: 'unknown flag: --slurp' }, 'GITHUB_CLI_UNSUPPORTED', false, false],
        [{ signal: 'SIGTERM' }, 'GITHUB_INTERRUPTED', false, true],
        [{ code: 'ETIMEDOUT' }, 'GITHUB_TIMEOUT', true, true],
        [{ code: 'EAI_AGAIN' }, 'GITHUB_DNS_FAILED', true, true],
        [{ stderr: 'dial tcp: no such host' }, 'GITHUB_DNS_FAILED', true, true],
        [{ stderr: 'proxyconnect tcp: connection refused' }, 'GITHUB_CONNECTION_FAILED', true, true],
        [{ stderr: 'unexpected EOF' }, 'GITHUB_CONNECTION_RESET', true, true],
        [{ stderr: 'i/o timeout' }, 'GITHUB_TIMEOUT', true, true],
        [{ stderr: '(HTTP 503)' }, 'GITHUB_REQUEST_FAILED', true, true],
    ];
    for (const [native, code, automatic, manual] of cases) {
        let calls = 0, recoveries = 0;
        const close = requestRecovery((error, round) => {
            recoveries++; assert.equal(round, 1); assert.equal(error.message, code); return false;
        });
        try {
            assert.throws(() => githubRequest(() => {
                calls++; throw Object.assign(new Error('secret'), native);
            }, { wait() {} }), error => error.message === (manual ? 'WIZARD_SAVE' : code) && !JSON.stringify(error).includes('secret'));
            assert.equal(calls, automatic ? 3 : 1, code);
            assert.equal(recoveries, manual ? 1 : 0, code);
        } finally { close(); }
    }
    for (const [stderr, code, retryable] of [
        ['Authentication failed', 'GIT_AUTH_REQUIRED', false],
        ['Permission denied (publickey)', 'GIT_AUTH_REQUIRED', false],
        ['The requested URL returned error: 407', 'GITHUB_PROXY_AUTH_REQUIRED', false],
        ['[rejected] non-fast-forward', 'GIT_REMOTE_REJECTED', false],
        ['[remote rejected] topic (pre-receive hook declined)', 'GIT_REMOTE_REJECTED', false],
        ['[remote rejected] topic (shallow update not allowed)', 'GIT_REMOTE_REJECTED', false],
        ['[remote rejected] topic (refusing to allow an OAuth App to create or update workflow `.github/workflows/test.yml` without `workflow` scope)', 'GIT_WORKFLOW_SCOPE_REQUIRED', false],
        ['[remote rejected] topic (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/test.yml` without `workflow` scope)', 'GIT_WORKFLOW_SCOPE_REQUIRED', false],
        ['[remote rejected] topic (refusing to allow a GitHub App to create or update workflow `.github/workflows/test.yml` without `workflows` permission)', 'GIT_WORKFLOW_SCOPE_REQUIRED', false],
        ['The requested URL returned error: 403', 'GIT_REMOTE_UNAVAILABLE', false],
        ['SSL certificate problem: unable to get local issuer certificate', 'GITHUB_TLS_FAILED', false],
        ['Failed to connect to github.com port 443: Connection refused', 'GITHUB_CONNECTION_FAILED', true],
        ['The requested URL returned error: 503', 'GIT_TRANSFER_FAILED', true],
    ]) {
        const error = gitFailure({ stderr: stderr + ' private output', status: 1 }, 'push');
        assert.equal(error.message, code); assert.equal(error.retryable, retryable);
        if (code === 'GIT_WORKFLOW_SCOPE_REQUIRED') assert.equal(error.recoverable, true);
        assert(!JSON.stringify(error).includes('private output'));
        if (code === 'GIT_REMOTE_REJECTED' || code === 'GITHUB_TLS_FAILED') {
            await assert.rejects(retryStep('pushingBranch', () => { throw error; },
                { retry() { assert.fail('deterministic rejection must not prompt'); } }), { message: code });
        }
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-local-errors-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.throws(() => git(directory, 'status'), { message: 'GIT_REPOSITORY_REQUIRED', tool: 'git' });
    git(directory, 'init');
    assert.throws(() => git(directory, '-c', 'user.name=', '-c', 'user.email=', 'commit', '--allow-empty', '-m', 'fixture'),
        { message: 'GIT_IDENTITY_REQUIRED', tool: 'git' });
    try { fs.readFileSync(path.join(directory, 'missing')); assert.fail(); }
    catch (error) { assert.equal(failureCode(error), 'LOCAL_FILE_MISSING'); }
    for (const [native, code] of [['EACCES', 'LOCAL_ACCESS_DENIED'], ['ENOSPC', 'LOCAL_STORAGE_FULL'], ['EEXIST', 'LOCAL_FILE_EXISTS'],
        ['EISDIR', 'LOCAL_PATH_TYPE_INVALID'], ['ENAMETOOLONG', 'LOCAL_PATH_TOO_LONG'], ['EBUSY', 'LOCAL_FILE_BUSY']]) {
        assert.equal(failureCode(Object.assign(new Error('private path'), { code: native })), code);
    }
    for (const [code, texts] of Object.entries(errors)) {
        assert.equal(texts.length, locales.length, code);
        assert(texts.every(text => typeof text === 'string' && text.trim()), code);
    }
});

test('真实 gh 未登录保留认证错误，HTTP 凭据和权限失败不混为网络故障', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-gh-auth-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
    let calls = 0;
    assert.throws(() => githubRequest(timeout => {
        calls++;
        return execFileSync('gh', ['api', '--hostname', 'github.com', 'user'], {
            env, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 32768, stdio: ['ignore', 'pipe', 'pipe'],
        });
    }), { message: 'GITHUB_AUTH_REQUIRED', retryable: false, attempts: 1 });
    assert.equal(calls, 1);
    for (const [status, message] of [[401, 'GITHUB_AUTH_INVALID'], [403, 'GITHUB_ACCESS_DENIED'], [429, 'GITHUB_RATE_LIMITED']]) {
        calls = 0;
        assert.throws(() => githubRequest(() => {
            calls++;
            return execFileSync(process.execPath, ['-e', "process.stderr.write('private credential (HTTP ' + process.argv[1] + ')'); process.exitCode = 1;", String(status)],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        }), error => error.message === message && error.status === status && error.attempts === 1 && !error.retryable
            && !JSON.stringify(error).includes('private credential'));
        assert.equal(calls, 1);
    }
});

test('登录完成才读取社区状态，向导未登录不准备 SDK 或询问密钥', async t => {
    const calls = [];
    const failure = Object.assign(new Error('GITHUB_AUTH_REQUIRED'), { github: true, retryable: false, attempts: 1 });
    const call = endpoint => { calls.push(endpoint); throw failure; };
    assert.throws(() => protectedSnapshot(call), { message: failure.message });
    assert.deepEqual(calls, ['user']);
    const actor = { id: 101, type: 'User', login: 'recipient' };
    const base = 'a'.repeat(40);
    const snapshot = protectedSnapshot(endpoint => {
        if (endpoint === 'user') return actor;
        if (endpoint === `repos/${policy.repository}`) return { id: policy.repositoryId, full_name: policy.repository,
            owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        assert.equal(endpoint, `repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`);
        return { object: { sha: base } };
    });
    assert.deepEqual(snapshot, { repositoryId: policy.repositoryId, base, actor: { ...actor, id: '101' } });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-auth-wizard-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let prepared = false;
    const spoken = [], questions = [];
    const result = await runWizard(directory, { call, stateHome: path.join(directory, 'history'),
        prepare() { prepared = true; throw new Error('UNEXPECTED_SDK_PREPARATION'); },
        ui: { locale: 'en-US', text: key => key, say: (key, value) => spoken.push([key, value]), close() {},
            task: (_key, work) => work(), select: async (key, values, label) => {
                questions.push(key);
                if (key === 'operation') return 'transfer';
                assert.equal(key, 'authenticationRecovery');
                assert.equal(label(values[0]), 'checkAuthentication');
                return 'saveExit';
            } } });
    assert.equal(prepared, false);
    assert.deepEqual(questions, ['operation', 'authenticationRecovery']);
    assert(spoken.some(([key, value]) => key === 'readingActor' && value.code === 'GITHUB_AUTH_REQUIRED'));
    assert(!spoken.some(([key]) => key === 'requestFailed'));
    assert.equal(result.failed, undefined);
});

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

test('读取逐请求自动重试后只恢复失败请求，手动轮次累加，写入仍由回读方处理', async () => {
    let before = 0, calls = 0, after = 0;
    const rounds = [];
    const close = requestRecovery((error, round) => {
        assert.equal(error.failureStep, 'readingGitObjects'); assert.equal(error.attempts, 3);
        rounds.push(round); return true;
    });
    try {
        before++;
        assert.equal(githubRequest(() => observe('readingGitObjects', '', () => {
            if (++calls <= 6) throw Object.assign(new Error('private'), { stderr: 'unexpected EOF' });
            return 'verified';
        }), { wait() {} }), 'verified');
        after++;
        assert.deepEqual([before, calls, after], [1, 7, 1]); assert.deepEqual(rounds, [1, 2]);
        assert.throws(() => githubRequest(() => { throw Object.assign(new Error('private'), { stderr: '(HTTP 503)' }); },
            { method: 'POST' }), { attempts: 1 });
        assert.deepEqual(rounds, [1, 2]);
    } finally { close(); }
    let writes = 0, reads = 0, prompts = 0;
    const run = () => retryStep('creatingPull', () => {
        reads++;
        if (++writes <= 6) throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true, retryable: true, method: 'POST' });
        return 'created';
    }, { wait() {}, retry: error => { assert.equal(error.retryRound, ++prompts); assert.equal(error.attempts, 3); return true; } });
    assert.equal(await run(), 'created'); assert.deepEqual([writes, reads, prompts], [7, 7, 2]);
});
