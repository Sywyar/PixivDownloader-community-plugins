import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { terminal, locales, localizedText } from '../submission-ui.mjs';
import { licenseFields, marketFields } from '../submission-fields.mjs';
import { prepareSubmission } from './local-sdk.mjs';
import { root, hash } from '../sdk.mjs';
import { git } from '../project.mjs';
import { httpsUrl } from '../download.mjs';
import { runWizard } from './local-sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { navigation, unavailable } from '../submission-navigation.mjs';
import { publisherOwner } from '../submission-release.mjs';
import { unlockPrivateKey } from '../submission-signing.mjs';
import { errors, optionNames } from '../submission-messages.mjs';
import { optionText, formatMetadata } from '../submission-presentation.mjs';
import { presentOriginal } from '../submission-version-state.mjs';
import { connectTerminal } from '../submission-terminal.mjs';

const originalTerm = process.env.TERM;
before(() => { process.env.TERM = 'xterm-256color'; });
after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });

test('组织历史按数字身份恢复，改名后仍重新校验当前成员资格', async () => {
    const answers = new Map();
    const store = { folder: '/project-a', answer: key => answers.get(key), remember: (key, value) => answers.set(key, value) };
    let login = 'first-name'; let active = true; let memberships = 0;
    const defaults = [];
    const ui = { text: key => key, confirm: async () => true, ask: async (_key, value) => value,
        select: async (key, values, label, initial) => {
            if (key === 'owner') return 'organization';
            assert.equal(key, 'organization'); assert.equal(label('301'), login); defaults.push(initial); return '301';
        } };
    const call = endpoint => {
        if (endpoint === 'user/orgs?per_page=100') return [[{ id: 301, login }]];
        if (endpoint === 'organizations/301') return { id: 301, type: 'Organization', login };
        assert.equal(endpoint, 'user/memberships/orgs/' + login); memberships++;
        return { state: active ? 'active' : 'pending', user: { id: 201 }, organization: { id: 301 } };
    };
    const run = () => navigation(ui, () => store).run(form => publisherOwner({ ui: form, call,
        state: { tree: new Map() }, snapshot: { actor: { id: '201', login: 'developer' } }, sdk: { invoke() {} } }));
    const owner = await run(); assert.equal(owner.accountId, '301');
    login = 'renamed'; assert.deepEqual(await run(), owner);
    assert.deepEqual(defaults, [undefined, '301']); assert.equal(memberships, 2);
    active = false; await assert.rejects(run(), /OWNER_AUTHORIZATION_REQUIRED/u);
});

function consoleStreams() {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = value => { input.isRaw = value; };
    let rendered = '';
    const output = new Writable({ write(chunk, _encoding, done) { rendered += chunk; done(); } });
    Object.assign(output, { isTTY: true, columns: 80, rows: 24 });
    return { input, output, rendered: () => rendered, key: async value => { await setImmediate(); input.write(value); } };
}

test('公共终端会话在问题和加载切换时保持逐键模式，退出恢复原状态', { timeout: 10000 }, async () => {
    const tty = consoleStreams();
    const originalRawMode = tty.input.setRawMode;
    const resume = tty.input.resume;
    const reads = [];
    tty.input.resume = function () { reads.push(this.isRaw); return resume.call(this); };
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    try {
        for (const key of ['license', 'risk']) {
            reads.length = 0;
            const confirmation = ui.confirm(key, { executionMode: 'host-process-full-trust' });
            await tty.key('\x1b[B');
            assert(reads.length > 0); assert(reads.every(Boolean));
            await tty.key('\r'); assert.equal(await confirmation, true);
        }
        reads.length = 0;
        const selection = ui.select('keyAction', ['existingKey', 'generateKey'], value => ui.text(value));
        await tty.key('\x1b[B');
        assert(reads.length > 0); assert(reads.every(Boolean));
        await tty.key('\r'); assert.equal(await selection, 'generateKey');
        await ui.task('prepare', async () => {});
        const fields = [
            [() => ui.ask('name'), 'example\r', 'example'],
            [() => ui.password(), 'example\r', 'example'],
            [() => ui.multiselect('tags', ['a', 'b']), '\x1b[B \r', ['b']],
        ];
        for (const [ask, keys, expected] of fields) {
            reads.length = 0;
            const answer = ask();
            await tty.key(keys);
            assert.deepEqual(await answer, expected);
            assert(reads.length > 0); assert(reads.every(Boolean));
        }
    } finally { ui.close(); }
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.setRawMode, originalRawMode);
    ui.close();
    tty.input.setRawMode(true);
    tty.key('\r');
    const resumed = await terminal(tty.input, tty.output, { resumeLocale: 'en-US' });
    resumed.close();
    assert.equal(tty.input.isRaw, true);
});

test('密钥格式和算法错误在各语言保留独立提示，不误报为密码错误', async () => {
    const codes = ['KEY_FORMAT_INVALID', 'KEY_ENCRYPTION_UNSUPPORTED', 'KEY_ENCRYPTION_PARAMETERS_INVALID'];
    for (const [index, locale] of locales.entries()) {
        const tty = consoleStreams();
        tty.key('\x1b[B'.repeat(index) + '\r');
        const ui = await terminal(tty.input, tty.output);
        try {
            assert.equal(ui.locale, locale);
            for (const code of codes) {
                assert(errors[code][index]);
                assert.notEqual(errors[code][index], errors.KEY_PASSWORD_INVALID[index]);
                ui.say('failed', { code });
                assert(tty.rendered().includes(errors[code][index]));
                assert(tty.rendered().includes(code));
            }
            assert(!tty.rendered().includes(errors.KEY_PASSWORD_INVALID[index]));
        } finally { ui.close(); }
    }
});

test('五种语言在终端展示版本状态、操作影响和下一步，错误码保留具体说明', async () => {
    for (const locale of locales) {
        const tty = consoleStreams(); tty.key('\r');
        const ui = await terminal(tty.input, tty.output, { resumeLocale: locale });
        try {
            for (const currentState of ['ACTIVE', 'YANKED', 'REVOKED']) {
                const record = { value: { pluginId: 'example', version: '2.3.4', package: { sha256: 'a'.repeat(64) } } };
                presentOriginal({ ui, state: { tree: new Map(), currentStatus: () => ({ state: currentState }) } }, record);
                assert.notEqual(ui.text('version' + currentState), 'version' + currentState);
                assert(tty.rendered().includes(ui.text('version' + currentState)));
                assert(tty.rendered().includes(optionText(currentState, ui.text)));
                assert(!tty.rendered().includes(ui.text('statusLabel') + ': ' + currentState));
            }
            for (const key of ['effectYANK', 'effectUNYANK', 'effectREVOKE', 'requestPending', 'requestApplied',
                'statusRequestApplied', 'statusRequestSubmitted', 'transferVersionStates', 'rotationVersionNotice', 'revokedRequestState']) {
                assert.notEqual(ui.text(key), key);
                ui.say(key);
                assert(tty.rendered().includes(ui.text(key)));
            }
            for (const code of ['VERSION_DIGEST_CONFLICT', 'VERSION_ALREADY_PUBLISHED', 'VERSION_SUBMISSION_OCCUPIED',
                'INVALID_STATE_TRANSITION', 'BASELINE_CHANGED', 'APPEND_ONLY_REQUIRED', 'NO_PUBLISHED_VERSIONS']) {
                ui.say('failed', { code });
                assert(tty.rendered().includes(errors[code][locales.indexOf(locale)]));
            }
        } finally { ui.close(); }
    }
});

test('解锁只为缺少或错误密码再次提问，格式错误和公私钥不配套直接报告', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'key-error-'));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const file = path.join(directory, 'private.pem');
    fs.writeFileSync(file, '-----BEGIN ENCRYPTED PRIVATE KEY-----\n');
    for (const code of ['KEY_FORMAT_INVALID', 'KEY_ENCRYPTION_UNSUPPORTED', 'KEY_ENCRYPTION_PARAMETERS_INVALID', 'KEY_PAIR_MISMATCH']) {
        const error = Object.assign(new Error('java failed'), { stderr: `java.io.IOException: ${code}\n` });
        await assert.rejects(unlockPrivateKey({ sign() { throw error; }, ui: { password() { assert.fail('must not ask for a password'); } } }, file, 'public.pem'), error);
    }
    for (const code of ['KEY_PASSWORD_REQUIRED', 'KEY_PASSWORD_INVALID']) {
        let password; let prompts = 0;
        const sign = () => { if (!password) throw new Error(code); };
        sign.password = (_file, value) => { password = value; };
        await unlockPrivateKey({ sign, ui: { password(_key, validate) { prompts++; validate('new-password'); } } }, file, 'public.pem');
        assert.equal(prompts, 1);
    }
});

test('真实终端返回修改前一项、清空可选值、保存退出并隐藏密码', { timeout: 10000 }, async t => {
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    t.after(() => ui.close());
    const answers = new Map();
    const store = { folder: '/project-a', answer: key => answers.get(key), remember: (key, value) => answers.set(key, value) };
    const navigator = navigation(ui, () => store);
    const running = navigator.run(async form => ({ name: await form.ask('name'), summary: await form.ask('summary') }));
    await tty.key('First\r'); await setImmediate();
    await tty.key('\x02'); await setImmediate();
    await tty.key('\x7f'.repeat(5) + 'Second\r'); await setImmediate();
    await tty.key('Summary\r');
    assert.deepEqual(await running, { name: 'Second', summary: 'Summary' });
    tty.key('\x7f'.repeat(3) + '\r');
    assert.equal(await ui.ask('description', 'old'), '');
    tty.key('private-passphrase\r');
    assert.equal(await navigator.ui.password('password'), 'private-passphrase');
    assert(!tty.rendered().includes('private-passphrase'));
    assert(!JSON.stringify([...answers]).includes('private-passphrase'));
    tty.key('\x13');
    await assert.rejects(navigator.run(form => form.ask('name')), /WIZARD_SAVE/u);
    assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('真实终端接受发布者校验结果，返回时重校验，并接受路径和密码的成功结果', { timeout: 10000 }, async t => {
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    t.after(() => ui.close());
    let validations = 0;
    const sdk = { invoke(input) {
        assert.deepEqual(input, { command: 'field', field: 'publisher', value: 'developer' });
        validations++;
        return { valid: true };
    } };
    const running = navigation(ui).run(async form => ({
        owner: await publisherOwner({ ui: form, sdk, state: { tree: new Map() }, snapshot: { actor: { id: '201', login: 'developer' } } }),
        summary: await form.ask('summary'),
    }));
    await tty.key('\r'); await setImmediate();
    await tty.key('\r'); await setImmediate();
    await tty.key('\x1b[B\r'); await setImmediate();
    await tty.key('\x02'); await setImmediate();
    assert.equal(validations, 2);
    await tty.key('\x1b[B\r'); await setImmediate();
    await tty.key('Summary\r');
    assert.deepEqual(await running, { owner: { accountId: '201', accountType: 'User', publisherId: 'developer' }, summary: 'Summary' });
    tty.key('example.pem\r');
    assert.equal(await ui.ask('privateKey', '', value => path.resolve(value)), 'example.pem');
    let settled = false;
    const password = ui.password('password', value => {
        if (value !== 'secret') throw new Error('KEY_PASSWORD_MISMATCH');
        return { valid: true };
    }).then(value => { settled = true; return value; });
    await tty.key('wrong\r'); await setImmediate();
    assert.equal(settled, false);
    await tty.key('\x7f'.repeat(5) + 'secret\r');
    assert.equal(await password, 'secret');
    assert(!tty.rendered().includes('secret'));
});

test('各语言使用真实交互确认，外部显示值不能注入终端控制字符', async () => {
    const prompts = new Set();
    for (let i = 0; i < locales.length; i++) {
        const tty = consoleStreams();
        tty.key('\x1b[B'.repeat(i) + '\r');
        const ui = await terminal(tty.input, tty.output);
        assert.equal(ui.locale, locales[i]);
        prompts.add(ui.text('trust'));
        tty.key('\x1b[B\r');
        assert.equal(await ui.confirm('trust', { project: '中文工程', profile: 'maven-java17-v1' }), true);
        const preview = ui.confirm('preview', {
            title: 'Example submission', repository: 'example/community', actor: { login: 'author' },
            fork: { name: 'author/community' }, branch: 'community/example',
            files: [{ path: 'submissions/example.json', sha256: 'a'.repeat(64), content: '{"example":true}' }],
            actions: ['CREATE_FORK', 'CREATE_COMMIT', 'PUSH_BRANCH', 'CREATE_READY_PR'],
        });
        await tty.key('\x1b[B\r');
        await tty.key('\r');
        assert.equal(await preview, false);
        assert(tty.rendered().includes(ui.text('submissionSummary')));
        assert(tty.rendered().includes('submissions/example.json'));
        assert(tty.rendered().includes('a'.repeat(64)));
        tty.key('\r');
        assert.equal(await ui.select('publisher', ['safe\x1b[2J', 'second']), 'safe\x1b[2J');
        assert(!tty.rendered().includes('\x1b[2J')); assert(tty.rendered().includes('\\u001b'));
        const beforeClose = tty.rendered();
        ui.close();
        assert.equal(tty.rendered(), beforeClose);
        assert.equal(tty.input.isRaw, false);
        assert.equal(tty.input.isPaused(), true);
        assert.equal(tty.input.listenerCount('keypress'), 0);
    }
    assert.equal(prompts.size, locales.length);
});

test('摘要单独确认后才展示完整内容，快捷键说明与引导线对齐', async t => {
    const tty = consoleStreams(); tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output); t.after(() => ui.close());
    const preview = ui.confirm('preview', { title: 'Example', repository: 'example/community', actor: { login: 'author' },
        fork: { name: 'author/community' }, branch: 'community/example', files: [{ path: 'unique-preview-file.json' }], actions: [] });
    await setImmediate();
    assert(tty.rendered().includes(ui.text('submissionSummary')));
    assert(!tty.rendered().includes('unique-preview-file.json'));
    await tty.key('\x1b[B\r'); await setImmediate();
    assert(tty.rendered().includes('unique-preview-file.json'));
    await tty.key('\r'); assert.equal(await preview, false);
    const name = ui.ask('name'); await tty.key('Example\r'); await name;
    assert(tty.rendered().includes('│  ' + ui.text('formNavigation')));
});

test('恢复提示使用已保存语言，继续跳过语言选择，拒绝恢复回到普通向导', async () => {
    for (const locale of locales) for (const resume of [true, false]) {
        const tty = consoleStreams();
        tty.output.columns = 240;
        const opening = terminal(tty.input, tty.output, { resumeLocale: locale });
        await setImmediate();
        assert(tty.rendered().includes((await import('../submission-ui.mjs')).localizedText(locale, 'resumeSession')));
        for (const key of ['yes', 'no']) {
            const label = (await import('../submission-ui.mjs')).localizedText(locale, key);
            assert.notEqual(label, key);
            assert(tty.rendered().includes(label));
        }
        await tty.key(resume ? '\r' : '\x1b[B\r');
        if (!resume) await tty.key('\x1b[B\r');
        const ui = await opening;
        assert.equal(ui.resume, resume); assert.equal(ui.locale, resume ? locale : 'en-US');
        ui.close();
    }
});

test('恢复已拒绝的密钥确认时重新提问，解锁成功不会重放上次取消', { timeout: 10000 }, async () => {
    let history = [];
    const first = consoleStreams(); first.key('\x1b[B\r');
    const original = await terminal(first.input, first.output);
    const form = async ui => {
        await ui.password('password', value => { if (value !== 'secret') throw new Error('KEY_PASSWORD_INVALID'); });
        return ui.confirm('keyAction', { keyId: 'example-key' });
    };
    try {
        const running = navigation(original, () => null, { onChange: value => { history = value; } }).run(form);
        await first.key('secret\r'); await setImmediate();
        await first.key('\r'); assert.equal(await running, false);
    } finally { original.close(); }
    assert(!JSON.stringify(history).includes('secret'));
    const second = consoleStreams(); second.key('\r');
    const resumed = await terminal(second.input, second.output, { resumeLocale: 'en-US' });
    try {
        let finished = false;
        const running = navigation(resumed, () => null, { history: JSON.parse(JSON.stringify(history)) }).run(form)
            .then(value => { finished = true; return value; });
        await second.key('secret\r'); await setImmediate();
        assert.equal(finished, false);
        assert(second.rendered().includes(resumed.text('keyAction')));
        await second.key('\x1b[B\r'); assert.equal(await running, true);
        assert(!second.rendered().includes('secret'));
    } finally { resumed.close(); }
});

test('所有语言的原因与转移选项显示名称并返回原协议值，预览保留原始标识', async () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/catalogs.json'), 'utf8'));
    for (const value of [...catalog.categories, ...catalog.tags, ...catalog.riskSignals]) {
        if (!['pixiv', 'smtp'].includes(value)) assert(Object.hasOwn(optionNames, value), value);
    }
    for (const locale of locales) {
        const tty = consoleStreams(); tty.key('\r');
        const ui = await terminal(tty.input, tty.output, { resumeLocale: locale });
        try {
            for (const [key, values] of [['reason', ['ROUTINE_ROTATION', 'KEY_LOST', 'KEY_COMPROMISED']], ['mode', ['REGULAR', 'RECOVERY']]]) {
                const selected = ui.select(key, values);
                await tty.key('\x1b[B\r');
                assert.equal(await selected, values[1]);
                for (const value of values) assert(tty.rendered().includes(optionText(value, ui.text)));
            }
            const tags = ui.multiselect('tags', ['download', 'metadata']);
            await tty.key(' \r');
            assert.deepEqual(await tags, ['download']);
            assert(tty.rendered().includes(optionText('download', ui.text)));
            const output = formatMetadata({ role: 'FROM', protection: 'protectedKey', reasonCode: 'ROUTINE_ROTATION',
                signals: ['FILE_READ'], keyId: 'FILE_READ', present: true }, ui.text);
            assert(output.includes(optionText('FROM', ui.text)));
            assert(output.includes(optionText('FILE_READ', ui.text)));
            assert(output.includes(ui.text('yes')));
            assert(output.includes('keyId: FILE_READ'));
            for (const value of Object.keys(optionNames)) {
                assert.notEqual(localizedText(locale, 'option.' + value), 'option.' + value);
                assert.notEqual(optionText(value, ui.text), value);
            }
            for (const code of ['PUBLISHER_IDENTITY_INVALID', 'PUBLISHER_STATE_INVALID', 'PUBLISHER_STATE_LOCKED', 'PUBLISHER_STATE_SIZE_EXCEEDED']) {
                assert.equal(errors[code].length, locales.length);
                assert(errors[code][locales.indexOf(locale)]?.trim());
            }
        } finally { ui.close(); }
    }
});

test('keyId 帮助紧邻输入显示，各语言可直接确认自动标识', async () => {
    const keyId = 'b57a2983-327b-4a5a-b8a0-76676d154cef';
    for (const locale of locales) {
        const tty = consoleStreams(); tty.key('\r');
        const ui = await terminal(tty.input, tty.output, { resumeLocale: locale });
        try {
            ui.say('keyIdHelp');
            const answer = ui.ask('keyId', keyId);
            await tty.key('\r');
            assert.equal(await answer, keyId);
            assert(tty.rendered().includes(ui.text('keyIdHelp')));
            assert(tty.rendered().includes(ui.text('keyId')));
        } finally { ui.close(); }
    }
});

test('真实业务线程阻塞期间终端持续刷新，异步字段验证和密码通过线程交接', { timeout: 10000 }, async t => {
    // 此夹具模拟交互终端；Clack 在 CI 日志模式下有意停止重复动画帧。
    const originalCI = process.env.CI;
    process.env.CI = 'false';
    t.after(() => { if (originalCI === undefined) delete process.env.CI; else process.env.CI = originalCI; });
    const tty = consoleStreams();
    const cancelled = new Int32Array(new SharedArrayBuffer(4));
    const blocked = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { workerTerminal } from ${JSON.stringify(new URL('../submission-terminal.mjs', import.meta.url).href)};
        import { observe } from ${JSON.stringify(new URL('../submission-progress.mjs', import.meta.url).href)};
        import { navigation } from ${JSON.stringify(new URL('../submission-navigation.mjs', import.meta.url).href)};
        const ui = await workerTerminal(parentPort, workerData.cancelled);
        const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        await ui.task('preparing', () => observe('checkingPath', '', () => Atomics.wait(workerData.blocked, 0, 0, 5000)));
        const value = await ui.ask('name', '', value => { wait(100); if (value !== 'Example') throw new Error('FIELD_PLACEHOLDER'); });
        const password = await ui.password('password', value => { if (value !== 'secret') throw new Error('KEY_PASSWORD_INVALID'); });
        const reason = await ui.select('reason', ['ROUTINE_ROTATION', 'KEY_LOST']);
        let attempts = 0;
        const nav = navigation(ui, undefined, { onFailure: async error => {
            ui.say('requestFailed', { code: error.message, stage: error.downloadStage, attempts: error.attempts });
            return await ui.select('retrySubmission', ['retry', 'saveExit'], key => ui.text(key)) === 'retry';
        } });
        await nav.run(() => ui.task('validating', async () => {
            if (++attempts === 1) throw Object.assign(new Error('DOWNLOAD_CONNECTION_RESET'), { download: true, retryable: true, downloadStage: 'PROXY_CONNECT', attempts: 3 });
        }));
        ui.close();
        parentPort.postMessage({ method: 'result', args: [{ value, passwordLength: password.length, reason, attempts }] });
        parentPort.close();
    `)), { workerData: { cancelled, blocked } });
    t.after(() => worker.terminate());
    const result = connectTerminal(worker, cancelled, tty.input, tty.output);
    result.catch(() => {}); // 断言失败后的线程清理不产生另一个未处理拒绝；下方仍核对原 Promise。
    const until = async value => { for (let i = 0; i < 100 && !tty.rendered().includes(value); i++) await setTimeout(20); assert(tty.rendered().includes(value), value); };
    await until('Choose a language'); await tty.key('\x1b[B\r');
    await until('Validate file paths'); const before = tty.rendered().length;
    for (let i = 0; i < 100 && tty.rendered().length === before; i++) await setTimeout(20);
    assert(tty.rendered().length > before);
    Atomics.store(blocked, 0, 1); Atomics.notify(blocked, 0);
    await until('Plugin display name'); await tty.key('Example\r');
    await until('Private key password'); await tty.key('secret\r');
    await until(optionText('ROUTINE_ROTATION', key => localizedText('en-US', key))); await tty.key('\x1b[B\r');
    await until('DOWNLOAD_CONNECTION_RESET'); await until('Save and exit'); await tty.key('\r');
    assert.deepEqual(await result, { value: 'Example', passwordLength: 6, reason: 'KEY_LOST', attempts: 2 });
    assert(!tty.rendered().includes('secret'));
});

test('方向键选择原始对象，空格多选可增删，错误输入原地重试且默认值可编辑', { timeout: 10000 }, async t => {
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    t.after(() => ui.close());
    try {
        const options = [{ id: 1 }, null, { id: 3 }];
        tty.key('\x1b[B\r');
        assert.equal(await ui.select('release', options, value => String(value?.id ?? 'URL')), null);
        tty.key(' \x1b[B \r');
        assert.deepEqual(await ui.multiselect('tags', ['a', 'b', 'c'], ['a']), ['b']);
        tty.key('\r');
        assert.deepEqual(await ui.multiselect('tags', ['a', 'b']), []);
        let settled = false;
        const answer = ui.ask('packageUrl', '', value => { httpsUrl(value); }).then(value => { settled = true; return value; });
        await tty.key('\r');
        await setImmediate();
        assert.equal(settled, false);
        await tty.key('http://example.org/file\r');
        await setImmediate();
        assert.equal(settled, false);
        await tty.key('\x7f'.repeat('http://example.org/file'.length) + 'https://example.org/file\r');
        assert.equal(await answer, 'https://example.org/file');
        tty.key('\x7f'.repeat('Old name'.length) + 'New name\r');
        assert.equal(await ui.ask('name', 'Old name'), 'New name');
        for (const response of ['y', 'YES', ' ', '1', '']) {
            tty.key(response + '\r');
            assert.equal(await ui.confirm('REVOKE', { plugin: 'example' }), false);
        }
        let confirmed = false;
        const confirmation = ui.confirm('REVOKE', { plugin: 'example' }).then(value => { confirmed = true; return value; });
        await tty.key('\x1b[B');
        await setImmediate();
        assert.equal(confirmed, false);
        await tty.key('\r');
        assert.equal(await confirmation, true);
        for (const cancel of ['\x1b', '\x03']) {
            tty.key('\x1b[B' + cancel);
            await assert.rejects(ui.confirm('preview', { plugin: 'example' }), /CANCELLED/u);
        }
        tty.key('\x1b');
        await assert.rejects(ui.select('operation', ['publish', 'REVOKE']), /CANCELLED/u);
    } finally { ui.close(); }
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('密钥证明引导默认签名，可切换人工审核，全部语言显示对应选项', async () => {
    for (const [index, locale] of locales.entries()) {
        const tty = consoleStreams();
        tty.key('\x1b[B'.repeat(index) + '\r');
        const ui = await terminal(tty.input, tty.output);
        try {
            const values = ['provideProof', 'skipProof'];
            const choose = () => ui.select('proofMethod', values, value => ui.text(value));
            tty.key('\r');
            assert.equal(await choose(), 'provideProof');
            tty.key('\x1b[B\r');
            assert.equal(await choose(), 'skipProof');
            for (const key of ['proofMethod', ...values]) {
                assert.notEqual(ui.text(key), key);
                assert(tty.rendered().includes(ui.text(key)), locale + ':' + key);
            }
            // 选择证明方式不授权签名；实际签名前的确认仍默认取消。
            tty.key('\r');
            assert.equal(await ui.confirm('keyAction', { keyId: 'example' }), false);
        } finally { ui.close(); }
    }
});

test('名称占位值不能确认，合法语言简码保留而错误语言标记拒绝', async t => {
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    t.after(() => ui.close());
    let settled = false;
    const placeholder = ui.text('name');
    const name = ui.ask('name', placeholder).then(value => { settled = true; return value; });
    await tty.key('\r'); await setImmediate();
    assert.equal(settled, false);
    await tty.key('\x7f'.repeat(placeholder.length) + 'Example name\r');
    assert.equal(await name, 'Example name');
    const sdk = prepareSubmission();
    for (const value of ['en', 'en-US', 'zh-Hant']) {
        assert.equal(sdk.invoke({ command: 'field', field: 'locale', value }).valid, true);
    }
    assert.throws(() => sdk.invoke({ command: 'field', field: 'locale', value: 'en_US' }), /LOCALE_INVALID/u);
});

test('更新保留其它语言与图片原始字节，并允许清空当前语言正文和主页', async () => {
    const image = fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/images/static.png'));
    const digest = hash(image);
    const oldPath = `assets/101/example/2.3.4/${digest}.png`;
    const previous = { defaultLocale: 'en', displayName: { en: 'Old name', 'zh-CN': '名称' },
        summary: { en: 'Summary', 'zh-CN': '摘要' }, description: { en: 'Remove this', 'zh-CN': '保留正文' },
        homepageUrl: 'https://example.org/', category: 'tools', tags: [],
        icon: { path: oldPath, alt: { en: 'Icon', 'zh-CN': '图标' } } };
    const before = structuredClone(previous);
    const changes = new Map();
    const market = await marketFields(null, {
        ask: async (key, fallback) => ['description', 'homepage'].includes(key) ? '' : key === 'name' ? 'New name' : fallback,
        select: async (key, values, _label, initial) => key === 'imageAction' ? 'keepImages' : initial ?? values[0],
        multiselect: async (_key, _values, initial) => initial,
    }, { accountId: '101' }, { pluginId: 'example', version: '2.3.5' }, changes, previous,
    file => { assert.equal(file, oldPath); return image; });
    assert.deepEqual(previous, before);
    assert.deepEqual(market.displayName, { en: 'New name', 'zh-CN': '名称' });
    assert.deepEqual(market.description, { 'zh-CN': '保留正文' });
    assert.equal(market.homepageUrl, undefined);
    assert.equal(market.icon.path, `assets/101/example/2.3.5/${digest}.png`);
    assert.deepEqual(market.icon.alt, before.icon.alt);
    assert.deepEqual(changes.get(market.icon.path), image);
});

test('首屏取消、输入关闭及加载失败释放终端，重定向输入不能自动确认', async () => {
    for (const key of ['\x03', '\x1b']) {
        const tty = consoleStreams();
        tty.key(key);
        await assert.rejects(terminal(tty.input, tty.output), /CANCELLED/u);
        assert.equal(tty.input.isRaw, false);
        assert.equal(tty.input.listenerCount('keypress'), 0);
    }
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    try {
        assert.equal(await ui.task('loading', async () => { await setTimeout(100); return 42; }), 42);
        await assert.rejects(ui.task('validating', () => { throw new Error('TEST_FAILURE'); }), /TEST_FAILURE/u);
        const answer = ui.ask('name');
        tty.input.end();
        await assert.rejects(answer, /CANCELLED/u);
    } finally { ui.close(); }
    await assert.rejects(terminal(new PassThrough(), tty.output), /INTERACTIVE_TERMINAL_REQUIRED/u);
});

test('加载时按 Esc 返回取消并恢复终端，不从组件中直接退出进程', async () => {
    const tty = consoleStreams();
    tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output);
    try {
        const result = ui.task('loading', () => setTimeout(100));
        await tty.key('\x1b');
        await assert.rejects(result, /CANCELLED/u);
    } finally { ui.close(); }
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount('keypress'), 0);
});

test('向导投影下载错误码及阶段，不输出原始异常或凭据', async () => {
    const sdk = prepareSubmission();
    const project = path.join(sdk.workspace, 'error-project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    git(project, 'init'); git(project, 'add', '.pixivdownloader-plugin-project');
    const previous = process.exitCode;
    const spoken = [];
    try {
        const result = await runWizard(project, { ui: { select: () => {
            throw Object.assign(new Error('DOWNLOAD_CONNECTION_RESET'), { downloadStage: 'PROXY_CONNECT', stderr: 'secret' });
        }, say: (...args) => spoken.push(args), close: () => {} } });
        assert.deepEqual(result, { failed: 'DOWNLOAD_CONNECTION_RESET' });
        assert.equal(process.exitCode, 1);
        assert.deepEqual(spoken, [['downloadFailed', { code: 'DOWNLOAD_CONNECTION_RESET', stage: 'PROXY_CONNECT' }]]);
    } finally { process.exitCode = previous; }
});

test('真实入口连续切换不可用操作后仍可返回菜单，不重复创建固定签名工具', async () => {
    const sdk = prepareSubmission(), project = path.join(sdk.workspace, 'menu-project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    git(project, 'init'); git(project, 'add', '.pixivdownloader-plugin-project');
    const spoken = [], operations = ['REVOKE', 'YANK', 'rotation', 'withdraw'];
    let base = 'a'.repeat(40);
    const call = endpoint => {
        if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: 'master' };
        if (endpoint === `${prefix}/git/ref/heads/master`) return { object: { sha: base } };
        if (endpoint === 'user') return { id: policy.repositoryOwnerId, type: 'User', login: policy.repository.split('/')[0] };
        if (endpoint.startsWith(`${prefix}/git/trees/`)) return { tree: [], truncated: false };
        if (endpoint.startsWith(`${prefix}/pulls?`)) return [[]];
        throw new Error('Unexpected request ' + endpoint);
    };
    const previous = process.exitCode;
    try {
        const result = await runWizard(project, { call, stateHome: project, ui: { locale: 'en-US', text: key => key,
            select: key => { assert.equal(key, 'operation'); if (!operations.length) throw new Error('CANCELLED'); return operations.shift(); },
            task: (_key, work) => work(), say: (...args) => {
                spoken.push(args);
                if (args[0] === 'operationUnavailable') base = (base[0] === 'a' ? 'b' : 'a').repeat(40);
            }, close() {} } });
        assert.deepEqual(result, { cancelled: true });
        assert.deepEqual(spoken.filter(([key]) => key === 'operationUnavailable').map(([, value]) => value.code),
            ['NO_OWNED_PLUGINS', 'NO_OWNED_PLUGINS', 'NO_OWNED_PUBLISHERS', 'NO_WITHDRAWABLE_REQUESTS']);
    } finally { process.exitCode = previous; }
});

test('市场默认语言跟随向导，首次显示名由开发者填写，已有市场信息继续作为建议', async () => {
    for (const locale of locales) {
        for (const previous of [undefined, { defaultLocale: 'en', displayName: { en: 'Existing name' }, summary: { en: 'Existing summary' } }]) {
            const defaults = new Map();
            const ui = { locale, ask: async (key, fallback = '') => {
                defaults.set(key, fallback);
                return fallback || ({ name: 'Entered name', summary: 'Entered summary' }[key] ?? '');
            }, select: async (_key, values) => values[0], multiselect: async () => [] };
            const market = await marketFields(null, ui, {}, { displayName: 'plugin.name' }, new Map(), previous);
            const expectedLocale = previous?.defaultLocale ?? locale;
            assert.equal(defaults.get('locale'), expectedLocale);
            assert.equal(defaults.get('name'), previous?.displayName.en ?? '');
            assert.equal(market.defaultLocale, expectedLocale);
            assert.deepEqual(market.displayName, { [expectedLocale]: previous?.displayName.en ?? 'Entered name' });
            assert.deepEqual(market.summary, { [expectedLocale]: previous?.summary.en ?? 'Entered summary' });
        }
    }
});

test('许可证按所选工程建议并确认，市场字段与图片由固定 SDK 接受', async () => {
    const sdk = prepareSubmission();
    const project = path.join(sdk.workspace, 'project');
    fs.mkdirSync(path.join(project, 'nested'), { recursive: true });
    git(project, 'init');
    const mit = fs.readFileSync(path.join(root, 'schemas/community/v1/licenses/MIT.txt'), 'utf8')
        .replace('<year>', '2020').replace('<copyright holders>', 'Example Authors');
    fs.writeFileSync(path.join(project, 'LICENSE'), 'root license');
    fs.writeFileSync(path.join(project, 'nested/LICENSE'), mit);
    git(project, 'add', 'LICENSE', 'nested/LICENSE');
    const ui = { text: key => key, select: async (_key, values) => values[0], ask: async (key, fallback) => {
        if (key === 'licenseFiles') assert.equal(fallback, 'nested/LICENSE');
        if (key === 'license') assert.equal(fallback, 'MIT');
        return fallback;
    }, confirm: async () => true };
    const license = await licenseFields(sdk, ui, project, 'nested');
    assert.equal(license.expression, 'MIT');
    assert.deepEqual(license.files, [{ path: 'nested/LICENSE', size: Buffer.byteLength(mit), sha256: hash(Buffer.from(mit)) }]);
    await assert.rejects(licenseFields(sdk, { ...ui, ask: async () => '../outside' }, project), /LICENSE_COMMIT_REQUIRED/u);
    const submission = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/vectors/submission.json'), 'utf8'));
    const image = path.join(root, 'schemas/community/v1/vectors/images/static.png');
    const changes = new Map();
    submission.market = await marketFields(sdk, { select: async (_key, values) => values[0], say: () => {},
        multiselect: async (_key, values) => values.slice(0, 2),
        ask: async (key, fallback) => ({ name: 'Example plugin', summary: 'Example summary', icon: image, screenshots: image,
            alt: 'Example image', description: '' })[key] ?? fallback ?? '' },
    { accountId: '101' }, { pluginId: submission.pluginId, version: submission.version, displayName: 'Example plugin' }, changes);
    assert.equal(submission.market.screenshots[0].path, submission.market.icon.path);
    assert.equal(changes.size, 1);
    assert.deepEqual([...changes.values()][0], fs.readFileSync(image));
    sdk.document('SUBMISSION', submission, 'submissions/101/' + submission.pluginId + '/' + submission.version + '.json');
});

test('连续临时子步骤不留下引导空行，空选项返回操作菜单且清除旧答案', async t => {
    const tty = consoleStreams(); tty.key('\x1b[B\r');
    const ui = await terminal(tty.input, tty.output); t.after(() => ui.close());
    const offset = tty.rendered().length;
    for (let i = 0; i < 30; i++) {
        const activity = ui.activity('readingGitObjects');
        activity.message(ui.text('checkingContract'));
        activity.clear();
    }
    assert(!tty.rendered().slice(offset).includes('\n'));
    let menus = 0, resets = 0;
    const navigator = navigation({ ...ui, select: async () => ++menus === 1 ? 'REVOKE' : 'publish' }, () => null,
        { onMenu: () => resets++ });
    const result = await navigator.run(async form => {
        const operation = await form.select('operation', ['REVOKE', 'publish']);
        if (operation === 'REVOKE') unavailable(form, 'NO_ELIGIBLE_VERSIONS');
        return operation;
    });
    assert.equal(result, 'publish'); assert.equal(resets, 1); assert.equal(menus, 2);
    await assert.rejects(ui.select('plugin', []), /WIZARD_MENU/u);
    assert(tty.rendered().includes(ui.text('operationUnavailable')));
});

test('已有 SDK 许可证仍可创建独立模板，保留原文件并要求重新提交源码', async () => {
    const sdk = prepareSubmission();
    const project = path.join(sdk.workspace, 'license-project'); fs.mkdirSync(project);
    git(project, 'init'); fs.writeFileSync(path.join(project, 'LICENSE'), 'Original notices'); git(project, 'add', 'LICENSE');
    const ui = { text: key => key, say() {}, select: async key => key === 'licenseAction' ? 'createLicense' : 'MIT',
        ask: async (key, initial, validate) => {
            const value = key === 'copyright' ? 'Plugin Author' : initial;
            if (key === 'licenseOutput') assert.throws(() => validate('LICENSE'), /LICENSE_FILE_EXISTS/u);
            validate?.(value); return value;
        }, confirm: async (_key, preview) => { assert(preview.text.includes('Plugin Author')); return true; } };
    assert.equal(await licenseFields(sdk, ui, project), null);
    assert.equal(fs.readFileSync(path.join(project, 'LICENSE'), 'utf8'), 'Original notices');
    assert(fs.readFileSync(path.join(project, 'LICENSE.plugin'), 'utf8').includes('Plugin Author'));
    assert.equal(git(project, 'ls-files', 'LICENSE.plugin'), '');
});
