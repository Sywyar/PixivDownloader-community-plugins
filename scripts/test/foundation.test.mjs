import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { acquireFoundation, acquireSources, foundationLock, foundationCache, verifyFoundation, readSourceBatch } from '../foundation-resources.mjs';
import { requestRecovery } from '../submission-retry.mjs';
import { recoverableRequest } from '../submission-github.mjs';
import { navigation } from '../submission-navigation.mjs';
import { api } from '../github.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('批量源码查询绑定精确路径；只有原始摘要匹配的文本可直接使用', () => {
    const bytes = Buffer.from('class Example {}\r\n');
    const entries = [{ path: 'module/Example.java', size: bytes.length, sha256: hash(bytes) }];
    const lock = { sourceCommit: 'a'.repeat(40) };
    const response = text => ({ data: { repository: { f0: { byteSize: bytes.length, isBinary: false, text } } } });
    const execute = value => (command, args, options) => {
        assert.equal(command, 'gh'); assert.deepEqual(args, ['api', 'graphql', '--input', '-']);
        assert(JSON.parse(options.input).query.includes(lock.sourceCommit + ':module/Example.java'));
        assert(options.timeout > 0 && options.timeout <= 1234);
        return JSON.stringify(value);
    };
    assert.deepEqual(readSourceBatch(lock, entries, Date.now() + 1234, execute(response(bytes.toString()))), [bytes]);
    assert.deepEqual(readSourceBatch(lock, entries, Date.now() + 1234, execute(response('class Example {}\n'))), [null]);
    assert.throws(() => readSourceBatch(lock, entries, Date.now() + 1234, execute({ errors: ['denied'] })), /GITHUB_RESPONSE_INVALID/);
    assert.throws(() => readSourceBatch(lock, entries, Date.now() + 1234, execute({ data: { repository: {} } })), /FOUNDATION_RESOURCE_CHANGED/);
});
function fixture(t) {
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'community-foundation-')));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    fs.mkdirSync(path.join(directory, 'tools'));
    const source = Buffer.from('public class Fixture {}'), jar = Buffer.from('dependency fixture');
    const lock = { schemaVersion: 1, repository: 'Sywyar/PixivDownloader', sourceCommit: 'a'.repeat(40),
        files: [{ path: 'module/Fixture.java', target: 'src/Fixture.java', size: source.length, sha256: hash(source) }],
        libraries: [{ path: 'example/library/1.0/library-1.0.jar', size: jar.length, sha256: hash(jar) }] };
    const write = value => fs.writeFileSync(path.join(directory, 'tools/foundation-lock.json'), JSON.stringify(value));
    write(lock);
    let calls = 0, downloads = 0;
    const call = (endpoint, options) => {
        calls++;
        assert.equal(endpoint, 'repos/Sywyar/PixivDownloader/contents/module/Fixture.java?ref=' + lock.sourceCommit);
        assert.equal(options.repositoryName, lock.repository);
        assert.equal(options.raw, true);
        return JSON.stringify({ type: 'file', path: lock.files[0].path, size: source.length, encoding: 'base64', content: source.toString('base64') });
    };
    const fetch = async (url, file, maximum, expected) => {
        downloads++;
        assert.equal(url, 'https://repo.maven.apache.org/maven2/' + lock.libraries[0].path);
        assert.equal(maximum, jar.length); assert.equal(expected.sha256, hash(jar));
        fs.writeFileSync(file, jar, { flag: 'wx' });
    };
    return { directory, source, jar, lock, write, call, fetch, counts: () => [calls, downloads] };
}

test('源码 GraphQL 只读请求在瞬时失败后恢复，自动耗尽保留诊断并允许继续或保存', t => {
    const f = fixture(t);
    const response = JSON.stringify({ data: { repository: { f0: {
        byteSize: f.source.length, isBinary: false, text: f.source.toString(),
    } } } });
    for (const [failures, resume] of [[1, true], [3, true], [3, false]]) {
        let calls = 0, recoveries = 0;
        const close = requestRecovery((error, round) => {
            recoveries++;
            assert.equal(round, 1);
            assert.equal(error.message, 'GITHUB_TIMEOUT');
            assert.equal(error.failureStep, 'verifyingTools');
            assert.equal(error.github, true); assert.equal(error.retryable, true);
            assert.equal(recoverableRequest(error), true);
            assert.equal(error.attempts, 3); assert.equal(error.totalAttempts, 3);
            assert(!JSON.stringify(error).includes('private diagnostic'));
            return resume;
        });
        try {
            const read = () => readSourceBatch(f.lock, f.lock.files, Date.now() + 60000, () => {
                if (++calls <= failures) throw Object.assign(new Error('private diagnostic'), { code: 'ETIMEDOUT' });
                return response;
            });
            if (resume) assert.deepEqual(read(), [f.source]);
            else assert.throws(read, { message: 'WIZARD_SAVE' });
            assert.equal(calls, failures + Number(resume));
            assert.equal(recoveries, failures === 3 ? 1 : 0);
        } finally { close(); }
    }
});

test('Contents 恢复只重试失败文件，保存后保留已验缓存；navigation 可继续原流程', async t => {
    const f = fixture(t);
    f.lock.files.push({ ...f.lock.files[0], path: 'module/Second.java', target: 'src/Second.java' });
    f.write(f.lock);
    let first = 0, second = 0, fail = true, prompts = 0;
    const call = (endpoint, options) => api(endpoint, options, () => {
        assert.equal(options.raw, true);
        const entry = f.lock.files.find(row => endpoint.includes('/contents/' + row.path + '?ref='));
        assert(entry);
        if (entry.target === 'src/Fixture.java') first++;
        else {
            second++;
            if (fail) throw Object.assign(new Error('private diagnostic'), { code: 'ETIMEDOUT' });
        }
        return JSON.stringify({ type: 'file', path: entry.path, size: f.source.length,
            encoding: 'base64', content: f.source.toString('base64') });
    });
    const close = requestRecovery(error => {
        assert.equal(error.attempts, 3); assert.equal(error.failureStep, 'verifyingTools'); return false;
    });
    try { assert.throws(() => acquireSources(f.directory, call), { message: 'WIZARD_SAVE' }); }
    finally { close(); }
    const cache = foundationCache(f.directory);
    assert.deepEqual(fs.readFileSync(path.join(cache, 'src/Fixture.java')), f.source);
    assert.equal(fs.existsSync(path.join(cache, 'src/Second.java')), false);
    const nav = navigation({}, () => null, { onFailure: async error => {
        prompts++;
        assert.equal(error.github, true); assert.equal(error.retryable, true);
        assert.equal(error.message, 'GITHUB_TIMEOUT'); assert.equal(error.attempts, 3);
        fail = false;
        return true;
    } });
    await nav.run(() => acquireSources(f.directory, call));
    assert.deepEqual([first, second, prompts], [1, 7, 1]);
    assert.deepEqual(fs.readFileSync(path.join(cache, 'src/Second.java')), f.source);
    assert(!fs.readdirSync(cache, { recursive: true }).some(file => file.endsWith('.tmp')));
});

test('源码获取的证书、权限和摘要拒绝不会自动放宽或写入缓存', t => {
    const f = fixture(t);
    for (const [native, code, recoverable] of [
        [{ code: 'CERT_HAS_EXPIRED' }, 'GITHUB_TLS_FAILED', false],
        [{ status: 1, stderr: '(HTTP 403)' }, 'GITHUB_ACCESS_DENIED', true],
    ]) for (const read of [
        execute => readSourceBatch(f.lock, f.lock.files, Date.now() + 60000, execute),
        call => acquireSources(f.directory, call),
    ]) {
        let calls = 0;
        assert.throws(() => read(() => { calls++; throw Object.assign(new Error('private'), native); }), error => {
            assert.equal(error.message, code); assert.equal(error.retryable, false);
            assert.equal(recoverableRequest(error), recoverable);
            assert(!JSON.stringify(error).includes('private'));
            return true;
        });
        assert.equal(calls, 1);
    }
    const close = requestRecovery(() => assert.fail('invalid bytes cannot be recovered as a request'));
    try {
        assert.throws(() => readSourceBatch(f.lock, f.lock.files, Date.now() + 60000, () => '{bad'), /GITHUB_RESPONSE_INVALID/);
        assert.throws(() => acquireSources(f.directory, (...args) => {
            const value = JSON.parse(f.call(...args));
            return JSON.stringify({ ...value, content: Buffer.alloc(f.source.length).toString('base64') });
        }), /FOUNDATION_RESOURCE_CHANGED/);
    } finally { close(); }
    assert.equal(fs.existsSync(foundationCache(f.directory)), false);
});

test('无缓存和 CLI 登录时真实源码获取入口保留认证错误并拒绝执行', t => {
    const f = fixture(t);
    const env = { ...process.env, GH_CONFIG_DIR: path.join(f.directory, 'isolated-gh'), GH_PROMPT_DISABLED: '1' };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
    assert.throws(() => readSourceBatch(f.lock, f.lock.files, Date.now() + 60000,
        (command, args, options) => execFileSync(command, args, { ...options, env })), {
        message: 'GITHUB_AUTH_REQUIRED', github: true, retryable: false, exitCode: 4, attempts: 1,
    });
    assert.throws(() => execFileSync(process.execPath,
        [fileURLToPath(new URL('../foundation-resources.mjs', import.meta.url)), 'fetch', f.directory],
        { env, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }), error => {
        assert.equal(error.status, 1);
        const result = JSON.parse(error.stdout);
        assert.equal(result.code, 'GITHUB_AUTH_REQUIRED'); assert.equal(result.github, true);
        assert.equal(result.retryable, false); assert.equal(result.recoverable, true);
        assert.equal(result.exitCode, 4); assert.equal(result.attempts, 1);
        return true;
    });
    assert.equal(fs.existsSync(foundationCache(f.directory)), false);
});

test('源码只读取精确 commit，全部依赖按原始摘要复验，缓存不重复下载', async t => {
    const f = fixture(t);
    const ready = await acquireFoundation(f.directory, f.fetch, f.call);
    assert.equal(verifyFoundation(ready.directory, ready.lock), true);
    await acquireFoundation(f.directory, () => assert.fail('download'), () => assert.fail('API'));
    assert.deepEqual(f.counts(), [1, 1]);
    fs.appendFileSync(path.join(ready.directory, 'src/Fixture.java'), 'changed');
    await assert.rejects(acquireFoundation(f.directory, f.fetch, f.call), /FOUNDATION_RESOURCE_CHANGED/);
    assert.deepEqual(f.counts(), [1, 1]);
});

test('错误源码、库摘要和来源不写入可用缓存，失败清理临时文件', async t => {
    const f = fixture(t);
    for (const change of [{ path: 'another.java' }, { encoding: 'utf8' }, { content: 'AAAA' }, { size: 1 }]) {
        assert.throws(() => acquireSources(f.directory, (...args) => JSON.stringify({ ...JSON.parse(f.call(...args)), ...change })), /FOUNDATION_RESOURCE_CHANGED/);
    }
    await assert.rejects(acquireFoundation(f.directory, async (_url, file) => fs.writeFileSync(file, 'bad'), f.call), /FOUNDATION_RESOURCE_CHANGED/);
    const cache = foundationCache(f.directory);
    assert.equal(verifyFoundation(cache, foundationLock(f.directory)), false);
    assert.equal(fs.readdirSync(cache, { recursive: true }).some(file => file.endsWith('.tmp')), false);
    const ready = await acquireFoundation(f.directory, f.fetch, f.call);
    assert.equal(verifyFoundation(ready.directory, ready.lock), true);
});

test('依赖下载失败后停止领取新任务，等待在途下载并清理各自临时文件', async t => {
    const f = fixture(t);
    f.lock.libraries = Array.from({ length: 5 }, (_, i) => ({ ...f.lock.libraries[0], path: `example/library-${i}.jar` }));
    f.write(f.lock);
    let started = 0, finished = 0, release;
    const concurrent = new Promise(resolve => { release = resolve; });
    const fetch = async (_url, file) => {
        const number = ++started;
        if (started === 4) release();
        await concurrent;
        if (number === 1) { fs.writeFileSync(file, 'partial'); throw new Error('download failed'); }
        await new Promise(resolve => setTimeout(resolve, 20));
        fs.writeFileSync(file, f.jar);
        finished++;
    };
    await assert.rejects(acquireFoundation(f.directory, fetch, f.call), /download failed/);
    assert.equal(started, 4);
    assert.equal(finished, 3);
    assert.equal(fs.readdirSync(foundationCache(f.directory), { recursive: true }).some(file => file.endsWith('.tmp')), false);
});

test('锁拒绝可变来源、路径逃逸、重复目标、过大累计预算和目录联接', t => {
    const f = fixture(t);
    for (const mutate of [
        value => { value.repository = 'attacker/repository'; },
        value => { value.sourceCommit = 'master'; },
        value => { value.files[0].path = '../file'; },
        value => { value.files[0].target = '../file'; },
        value => { value.files.push({ ...value.files[0] }); },
        value => { value.libraries[0].size = 64 * 1024 * 1024; },
        value => { value.libraries[0].sha256 = '0'.repeat(64); },
    ]) {
        const value = structuredClone(f.lock); mutate(value); f.write(value);
        assert.throws(() => foundationLock(f.directory), /FOUNDATION_LOCK_INVALID/);
    }
    f.write(f.lock);
    const cache = foundationCache(f.directory);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.symlinkSync(f.directory, cache, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyFoundation(cache, foundationLock(f.directory)), /FOUNDATION_PATH_INVALID/);
    fs.unlinkSync(cache);
});
