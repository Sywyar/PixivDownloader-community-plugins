import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openProject, projectIdentity } from '../submission-state.mjs';
import { sessionLocator, saveSession, savePrepared, preparedChanges, restorePrepared } from '../submission-session.mjs';
import { navigation } from '../submission-navigation.mjs';
import { API_BYTES } from '../github.mjs';

test('新进程按项目恢复语言和已答问题，未签名时仍解锁，完成预览不能清除待提交内容', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-session-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const identity = projectIdentity('101', '.', 'example');
    const store = openProject(identity, '201', { home });
    const context = { store, operation: 'publish', ui: { locale: 'zh-Hant' } };
    saveSession(context, { operation: 'publish' });
    sessionLocator(home, home).bind(store, '201');
    const ui = { select: (_key, values) => values[0], ask: key => {
        if (key === 'summary') throw new Error('WIZARD_SAVE'); return 'Example';
    }, password: () => 'never-save-this-password', confirm: () => true };
    const form = async ui => {
        const operation = await ui.select('operation', ['publish', 'YANK']);
        const name = await ui.ask('name', '', value => assert.equal(value, 'Example'));
        await ui.password('password'); return { operation, name, summary: await ui.ask('summary') };
    };
    const nav = navigation(ui, () => store, { onChange: history => saveSession(context, { navigation: history }) });
    await assert.rejects(nav.run(form), /WIZARD_SAVE/u);
    const profile = fs.readFileSync(path.join(store.folder, 'profile.json'), 'utf8');
    assert(!profile.includes('never-save-this-password')); assert(!profile.includes('"password"'));
    store.close();
    const moduleUrl = name => JSON.stringify(new URL('../' + name + '.mjs', import.meta.url).href);
    const child = `import { openProject } from ${moduleUrl('submission-state')};
        import { sessionLocator } from ${moduleUrl('submission-session')};
        import { navigation } from ${moduleUrl('submission-navigation')};
        const home = process.argv[1]; const saved = sessionLocator(home, home).read();
        const store = openProject(saved.identity, saved.actorId, { home }); let passwords = 0;
        const nav = navigation({ select() { throw Error('repeated selection'); },
            ask(key) { if (key !== 'summary') throw Error('repeated field'); return 'Continued'; },
            password() { passwords++; return 'fresh-memory-only'; } }, () => store, { history: saved.session.navigation });
        const value = await nav.run(async ui => { const operation = await ui.select('operation', ['publish', 'YANK']);
            const name = await ui.ask('name', '', value => { if (value !== 'Example') throw Error('bad value'); });
            await ui.password('password'); return { operation, name, summary: await ui.ask('summary') }; });
        store.close(); process.stdout.write(JSON.stringify({ value, locale: saved.session.locale, passwords }));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child, home], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual(result, { value: { operation: 'publish', name: 'Example', summary: 'Continued' }, locale: 'zh-Hant', passwords: 1 });
    context.store = openProject(identity, '201', { home });
    context.snapshot = { base: 'a'.repeat(40), actor: { id: '201' } };
    savePrepared(context, { title: 'chore(plugin): test', changes: new Map([['request.json', Buffer.from('{"signed":true}')]]) });
    const navigator = navigation(ui, () => context.store, { onChange: history => saveSession(context, { navigation: history, prepared: null }) });
    assert(await navigator.ui.confirm('preview', { files: [{ path: 'request.json' }] }));
    assert.equal(preparedChanges(context.store).changes.get('request.json').toString(), '{"signed":true}');
    context.store.complete({ url: 'https://example.invalid/pr/1' });
    assert.equal(sessionLocator(home, home).read(), null);
    assert.equal(fs.readdirSync(context.store.folder).filter(name => name.startsWith('pending-')).length, 0);
    context.store.close();
});

test('已准备内容按原始字节恢复，身份、篡改、超限和私钥内容均拒绝', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-prepared-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const identity = projectIdentity('101', '.', 'example');
    const store = openProject(identity, '201', { home }); t.after(() => store.close());
    const context = { store, ui: { locale: 'en-US', password() { assert.fail('must not unlock prepared data'); } },
        snapshot: { base: 'a'.repeat(40), actor: { id: '201' } } };
    saveSession(context, { operation: 'YANK' });
    const changes = new Map([['request.json', Buffer.from('{"signed":"exact bytes"}\n')], ['proof.bin', Buffer.from([0, 128, 255])]]);
    savePrepared(context, { changes, title: 'chore(plugin): test' });
    assert.deepEqual((await restorePrepared(context)).changes, changes);
    await assert.rejects(restorePrepared({ ...context, snapshot: { ...context.snapshot, base: 'b'.repeat(40) } }), /SESSION_IDENTITY_OR_BASE_CHANGED/u);
    assert.throws(() => savePrepared(context, { changes: new Map([['too-big', Buffer.alloc(API_BYTES + 1)]]) }), /INPUT_SIZE_EXCEEDED/u);
    assert.throws(() => savePrepared(context, { changes: new Map([['private.pem', Buffer.from('-----BEGIN PRIVATE KEY-----')]]) }), /PRIVATE_KEY_IN_SUBMISSION/u);
    const record = store.record.session.prepared;
    const file = path.join(store.folder, `pending-${record.digest}.bin`);
    fs.appendFileSync(file, 'changed');
    assert.throws(() => preparedChanges(store), /PROJECT_SESSION_CHANGED/u);
    const other = openProject(projectIdentity('101', 'nested', 'example'), '201', { home });
    assert.equal(other.record.session, undefined); other.close();
    store.close();
    const account = openProject(identity, '202', { home });
    assert.equal(account.record.session, undefined); account.close();
});
