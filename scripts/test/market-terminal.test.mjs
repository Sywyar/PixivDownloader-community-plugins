import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { terminal, locales } from '../submission-ui.mjs';
import { navigation } from '../submission-navigation.mjs';
import { errors } from '../submission-messages.mjs';
import { contentMessages } from '../submission-content-messages.mjs';
import { formatMetadata } from '../submission-presentation.mjs';

const originalTerm = process.env.TERM;
before(() => { process.env.TERM = 'xterm-256color'; });
after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });

for (const [index, locale] of locales.entries()) test(`${locale} 多行输入、空多选、返回、保存及恢复保留内容`, async () => {
    const input = new PassThrough(); input.isTTY = true;
    input.setRawMode = value => { input.isRaw = value; };
    let rendered = '';
    const output = new Writable({ write(bytes, _encoding, done) { rendered += bytes; done(); } });
    Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
    const key = async value => { await setImmediate(); input.write(value); };
    const started = terminal(input, output);
    await key('\x1b[B'.repeat(index) + '\r');
    const ui = await started;
    try {
        const selection = ui.multiselect('linkPresets', ['repository', 'documentation', 'issues'], []);
        await key('\r'); assert.deepEqual(await selection, []);
        let history;
        const form = navigation(ui, () => null, { onChange: values => { history = values; } });
        const pending = form.run(async view => {
            const text = await view.multiline('contentInput', '', () => {});
            await view.select('linkAction', ['linksDone']); return text;
        });
        await key('  First\rSecond'); await key('\t\r');
        await key('\x13'); await assert.rejects(pending, /WIZARD_SAVE/);
        assert.equal(history[0].value, '  First\nSecond');
        const resumed = navigation(ui, () => null, { history }).run(async view => view.multiline('contentInput', '', () => {}));
        assert.equal(await resumed, '  First\nSecond');
        for (const [code, expected] of [['\x02', 'WIZARD_BACK'], ['\x13', 'WIZARD_SAVE'], ['\x1b', 'CANCELLED']]) {
            const prompt = ui.multiline('contentInput');
            await key(code); await assert.rejects(prompt, new RegExp(expected));
        }
        for (const code of ['SDK_UPGRADE_REQUIRED', 'CONTENT_ASSET_CHANGED', 'CONTENT_RELEASE_CONFLICT',
            'CHANGELOG_VERSION_MISSING', 'CHANGELOG_VERSION_DUPLICATED', 'INVALID_UTF8']) {
            assert.equal(errors[code].length, locales.length);
            assert(ui.errorText(new Error(code)).includes(errors[code][index]));
        }
        assert(rendered.includes(ui.text('multilineNavigation')));
        for (const values of Object.values(contentMessages)) assert.equal(values.length, locales.length);
        const metadata = formatMetadata({ purpose: 'releaseNotes', kind: 'custom', sourcePath: 'README.md' }, ui.text);
        assert(metadata.includes(ui.text('contentPurpose')));
        assert(metadata.includes(ui.text('releaseNotes')));
        assert(metadata.includes(ui.text('linkPurpose')));
        assert(metadata.includes(ui.text('custom')));
        assert(metadata.includes(ui.text('contentSourcePath')));
    } finally { ui.close(); }
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
});
