import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { download } from '../download.mjs';
import { hash } from '../sdk.mjs';
import { navigation } from '../submission-navigation.mjs';
import { observe, progressReporter } from '../submission-progress.mjs';
import { requestDetails } from '../submission-github.mjs';

const reset = () => Object.assign(new Error('private URL and proxy password'), { code: 'ECONNRESET' });
const bytes = Buffer.from('verified package');
const expected = { size: bytes.length, sha256: hash(bytes) };
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const reply = (action, callback) => {
    const req = new EventEmitter();
    queueMicrotask(() => {
        if (action instanceof Error) { req.emit('error', action); return; }
        callback(Object.assign(Readable.from([bytes]), { statusCode: action, headers: {} }));
    });
    return req;
};

test('共享下载重试使用一个截止时间并清理半文件，安全与文件错误不得重试', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'download-retry-'));
    t.after(() => fs.rmSync(folder, { recursive: true }));
    let sequence = 0;
    const run = async (actions, overrides = {}) => {
        let clock = 0, calls = 0;
        const waits = [], events = [];
        const file = path.join(folder, String(++sequence));
        progressReporter(event => events.push(event));
        try {
            const result = await download('https://example.org/package', file, 100, expected, {
                lookup, proxyForUrl: async () => null, now: () => clock,
                wait: async ms => { waits.push(ms); clock += ms; },
                request: (_url, _options, callback) => reply(actions[Math.min(calls++, actions.length - 1)], callback),
                ...overrides,
            });
            return { result, calls, waits, events, file };
        } catch (error) { return { error, calls, waits, events, file }; }
        finally { progressReporter(() => {}); }
    };
    const recovered = await run([reset(), 503, 200]);
    assert.equal(recovered.result.sha256, expected.sha256);
    assert.deepEqual(recovered.waits, [1000, 2000]);
    assert.equal(recovered.calls, 3);
    assert.deepEqual(recovered.events.map(event => [event.step, event.detail, event.active]),
        [['retryingDownload', '2/3', true], ['retryingDownload', '2/3', false], ['retryingDownload', '3/3', true], ['retryingDownload', '3/3', false]]);
    const exhausted = await run([reset()]);
    assert.equal(exhausted.error.message, 'DOWNLOAD_CONNECTION_RESET');
    assert.equal(exhausted.error.download, true); assert.equal(exhausted.error.retryable, true);
    assert.equal(exhausted.calls, 3); assert.equal(exhausted.error.attempts, 3);
    assert(!JSON.stringify(exhausted.error).includes('password'));
    const deadline = await run([reset()], { timeout: 2500 });
    assert.equal(deadline.calls, 2); assert.deepEqual(deadline.waits, [1000]);
    let clock = 0;
    const late = await run([reset()], { timeout: 2000, now: () => clock, wait: async () => { clock = 2000; } });
    assert.equal(late.calls, 1); assert.equal(late.error.message, 'DOWNLOAD_TIMEOUT');
    clock = 0;
    const expiredCertificate = await run([], { timeout: 2000, now: () => clock,
        request: (_url, _options, callback) => { clock = 2000; return reply(Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }), callback); } });
    assert.equal(expiredCertificate.error.message, 'DOWNLOAD_TLS_FAILED');
    assert.equal(expiredCertificate.error.retryable, false);
    for (const action of [401, 403, 407, 429, Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' })]) {
        const result = await run([action]);
        assert.equal(result.calls, 1); assert.equal(result.error.retryable, false); assert.deepEqual(result.waits, []);
    }
    for (const override of [{ lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
        { request: (_url, _options, callback) => reply(200, response => { response.headers['content-length'] = 101; callback(response); }) },
        { request: (_url, _options, callback) => reply(200, response => { response.headers['content-encoding'] = 'gzip'; callback(response); }) },
        { request: (_url, _options, callback) => reply(200, response => { response.push(Buffer.from('tampered')); callback(response); }) }]) {
        const result = await run([200], override);
        assert.equal(result.error.retryable, false); assert.deepEqual(result.waits, []); assert(!fs.existsSync(result.file));
    }
    let resolutions = 0;
    const rebound = await run([reset(), 200], { lookup: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }] });
    assert.equal(rebound.calls, 1); assert.equal(rebound.error.message, 'NONPUBLIC_ADDRESS');
    assert.equal(rebound.error.retryable, false);
    const protectedFile = path.join(folder, String(sequence + 1)); fs.writeFileSync(protectedFile, 'existing');
    const local = await run([200]);
    assert.equal(local.error.downloadStage, 'FILE'); assert.equal(local.error.retryable, false);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'existing');
});

test('异步子步骤完成后才清除，失败仍清除且不吞异常', async () => {
    const events = []; progressReporter(event => events.push(event.active));
    try {
        let finish;
        const work = observe('retryingDownload', '2/3', () => new Promise(resolve => { finish = resolve; }));
        assert.deepEqual(events, [true]); finish('ok'); assert.equal(await work, 'ok');
        assert.deepEqual(events, [true, false]);
        await assert.rejects(observe('retryingDownload', '2/3', async () => { throw new Error('CANCELLED'); }), /CANCELLED/u);
        assert.deepEqual(events, [true, false, true, false]);
    } finally { progressReporter(() => {}); }
});

test('所有向导表单共用下载恢复，重试保留答案而安全失败不弹重试', async () => {
    const error = Object.assign(new Error('DOWNLOAD_CONNECTION_RESET'), { download: true, retryable: true, attempts: 3, downloadStage: 'PROXY_CONNECT' });
    let prompts = 0, tries = 0, retries = 0;
    const nav = navigation({ ask: () => { prompts++; return 'kept'; } }, undefined, { onFailure: failure => { assert.equal(failure, error); retries++; return true; } });
    assert.equal(await nav.run(async ui => { const answer = await ui.ask('name'); if (++tries === 1) throw error; return answer; }), 'kept');
    assert.equal(prompts, 1); assert.equal(retries, 1);
    for (const fatal of ['DOWNLOAD_DIGEST_CHANGED', 'DOWNLOAD_TLS_FAILED', 'NONPUBLIC_ADDRESS']) {
        await assert.rejects(nav.run(() => { throw Object.assign(new Error(fatal), { download: true, retryable: false }); }), new RegExp(fatal));
    }
    assert.equal(retries, 1);
    const save = navigation({}, undefined, { onFailure: () => { throw new Error('WIZARD_SAVE'); } });
    await assert.rejects(save.run(() => { throw error; }), /WIZARD_SAVE/u);
    assert.deepEqual(requestDetails({ status: 'secret', attempts: 100, downloadStage: 'https://secret' }), {});
    assert.deepEqual(requestDetails(error), { attempts: 3, stage: 'PROXY_CONNECT' });
});
