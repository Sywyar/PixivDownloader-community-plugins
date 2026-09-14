import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { terminal, locales } from '../submission-ui.mjs';
import { licenseFields, marketFields } from '../submission-fields.mjs';
import { prepareSubmission } from '../submission-sdk.mjs';
import { root, hash } from '../sdk.mjs';
import { git } from '../project.mjs';
import { httpsUrl } from '../download.mjs';
import { runWizard } from '../submit.mjs';

const originalTerm = process.env.TERM;
before(() => { process.env.TERM = 'xterm-256color'; });
after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });

function consoleStreams() {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = value => { input.isRaw = value; };
    let rendered = '';
    const output = new Writable({ write(chunk, _encoding, done) { rendered += chunk; done(); } });
    Object.assign(output, { isTTY: true, columns: 80, rows: 24 });
    return { input, output, rendered: () => rendered, key: async value => { await setImmediate(); input.write(value); } };
}

test('各语言使用真实交互确认，外部显示值不能注入终端控制字符', async () => {
    const prompts = new Set();
    for (let i = 0; i < locales.length; i++) {
        const tty = consoleStreams();
        tty.key('\x1b[B'.repeat(i) + '\r');
        const ui = await terminal(tty.input, tty.output);
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
        ask: async (key, fallback) => ({ summary: 'Example summary', icon: image, screenshots: image,
            alt: 'Example image', description: '' })[key] ?? fallback ?? '' },
    { accountId: '101' }, { pluginId: submission.pluginId, version: submission.version, displayName: 'Example plugin' }, changes);
    assert.equal(submission.market.screenshots[0].path, submission.market.icon.path);
    assert.equal(changes.size, 1);
    assert.deepEqual([...changes.values()][0], fs.readFileSync(image));
    sdk.document('SUBMISSION', submission, 'submissions/101/' + submission.pluginId + '/' + submission.version + '.json');
});
