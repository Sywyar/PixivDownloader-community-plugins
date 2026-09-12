import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { terminal, locales } from '../submission-ui.mjs';
import { licenseFields, marketFields } from '../submission-fields.mjs';
import { prepareSubmission } from '../submission-sdk.mjs';
import { root, hash } from '../sdk.mjs';
import { git } from '../project.mjs';

test('各语言使用真实交互确认，外部显示值不能注入终端控制字符', async () => {
    const prompts = new Set();
    for (let i = 0; i < locales.length; i++) {
        const input = new PassThrough();
        let rendered = '';
        const output = new Writable({ write(chunk, _encoding, done) { rendered += chunk; done(); } });
        const answer = value => setImmediate(() => input.write(value + '\n'));
        answer(String(i + 1));
        const ui = await terminal(input, output);
        prompts.add(ui.text('trust'));
        answer('YES');
        assert.equal(await ui.confirm('trust', { project: '中文工程', profile: 'maven-java17-v1' }), true);
        answer('');
        assert.equal(await ui.confirm('preview', { sha256: 'a'.repeat(64) }), false);
        answer('1');
        assert.equal(await ui.select('publisher', ['safe\x1b[2J', 'second']), 'safe\x1b[2J');
        assert(!rendered.includes('\x1b')); assert(rendered.includes('\\u001b'));
        ui.close();
    }
    assert.equal(prompts.size, locales.length);
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
        ask: async (key, fallback) => ({ summary: 'Example summary', tags: '1,2', icon: image, screenshots: image,
            alt: 'Example image', description: '' })[key] ?? fallback ?? '' },
    { accountId: '101' }, { pluginId: submission.pluginId, version: submission.version, displayName: 'Example plugin' }, changes);
    assert.equal(submission.market.screenshots[0].path, submission.market.icon.path);
    assert.equal(changes.size, 1);
    assert.deepEqual([...changes.values()][0], fs.readFileSync(image));
    sdk.document('SUBMISSION', submission, 'submissions/101/' + submission.pluginId + '/' + submission.version + '.json');
});
