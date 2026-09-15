import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { terminal, locales } from '../submission-ui.mjs';
import { licenseFields, marketFields } from '../submission-fields.mjs';
import { prepareSubmission } from '../submission-sdk.mjs';
import { root, hash } from '../sdk.mjs';
import { git } from '../project.mjs';
import { httpsUrl } from '../download.mjs';
import { runWizard } from '../submit.mjs';
import { navigation } from '../submission-navigation.mjs';
import { publisherOwner } from '../submission-release.mjs';
import { unlockPrivateKey } from '../submission-signing.mjs';
import { errors } from '../submission-messages.mjs';

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
        tty.key('\r');
        assert.equal(await ui.confirm('preview', {
            title: 'Example submission', repository: 'example/community', actor: { login: 'author' },
            fork: { name: 'author/community' }, branch: 'community/example',
            files: [{ path: 'submissions/example.json', sha256: 'a'.repeat(64), content: '{"example":true}' }],
            actions: ['CREATE_FORK', 'CREATE_COMMIT', 'PUSH_BRANCH', 'CREATE_READY_PR'],
        }), false);
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
        tty.key('\r');
        assert.equal(await ui.confirm('optionalKey', { keyId: 'example' }), false);
        assert(tty.rendered().includes(ui.text('skipProof')));
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
    const ui = { ask: async (key, fallback) => {
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
