import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openProject, projectIdentity, openManagement } from '../submission-state.mjs';
import { sessionLocator, saveSession, savePrepared, preparedChanges, restorePrepared } from '../submission-session.mjs';
import { navigation } from '../submission-navigation.mjs';
import { API_BYTES } from '../github.mjs';
import { policy, prefix } from '../github.mjs';
import { git } from '../project.mjs';
import { runWizard, withRepositoryFiles } from './local-sdk.mjs';
import { runWizard as productionWizard } from '../submit.mjs';

test('无项目管理记录按账号隔离，恢复不读取 Git 源码且继续核对登录身份', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'management-session-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const store = openManagement('201', { home });
    store.remember('transferPlugin:0', 'publisher/example');
    saveSession({ store, ui: { locale: 'zh-CN' } }, { operation: 'withdraw', sourceCommit: null });
    sessionLocator(home, home).bind(store, '201');
    store.close();
    assert.equal(sessionLocator(home, home).read().session.locale, 'zh-CN');
    const other = openManagement('202', { home });
    assert.equal(other.answer('transferPlugin:0'), undefined); other.close();
    const project = openProject(projectIdentity('101', '.', 'example'), '201', { home });
    assert.equal(project.answer('transferPlugin:0'), undefined); project.close();
    let accountId = '202';
    const call = endpoint => {
        if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: 'master' };
        if (endpoint === `${prefix}/git/ref/heads/master`) return { object: { sha: 'a'.repeat(40) } };
        if (endpoint === 'user') return { id: accountId, type: 'User', login: 'author' };
        if (endpoint.includes('/git/trees/')) return { tree: [], truncated: false };
        if (endpoint.includes('/pulls?')) return [[]];
        assert.fail(endpoint);
    };
    const previous = process.exitCode;
    t.after(() => { process.exitCode = previous; });
    const notices = [];
    const options = { call, stateHome: home, prepare: () => ({ workspace: fs.mkdtempSync(path.join(home, 'sdk-')) }), ui: {
        locale: 'zh-CN', resume: true, task: (_key, work) => work(), close() {}, text: key => key,
        say: (key, value) => notices.push({ key, value }),
        select: (key, values) => { assert.equal(key, 'operation'); assert(!values.includes('publish')); return 'withdraw'; },
    } };
    assert.deepEqual(await productionWizard(home, options), { failed: 'SESSION_ACCOUNT_CHANGED' });
    accountId = '201';
    let selections = 0;
    options.ui.select = (_key, values) => { assert(!values.includes('publish')); if (selections++) throw new Error('CANCELLED'); return 'withdraw'; };
    assert.deepEqual(await productionWizard(home, options), { cancelled: true });
    assert(notices.some(notice => notice.value?.code === 'NO_WITHDRAWABLE_REQUESTS'));
});

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

test('写入开始后主线刷新保留已答内容并重新确认，不恢复返回上一步权限', async () => {
    let prompts = 0, previews = 0, refreshes = 0, writes = 0;
    const nav = navigation({ ask: () => { prompts++; return 'request'; }, confirm: () => ++previews === 1 }, undefined,
        { onRefresh: () => { refreshes++; return true; } });
    const result = await nav.run(async ui => {
        assert.equal(await ui.ask('summary'), 'request');
        if (!await ui.confirm('preview')) return { cancelled: true };
        nav.seal(); writes++;
        throw new Error('COMMUNITY_BASE_CHANGED');
    });
    assert.deepEqual(result, { cancelled: true });
    assert.deepEqual({ prompts, previews, refreshes, writes }, { prompts: 1, previews: 2, refreshes: 1, writes: 1 });
    await assert.rejects(nav.run(() => { throw new Error('WIZARD_BACK'); }), /WIZARD_BACK/u);
});

test('已准备内容按原始字节恢复，身份、篡改、超限和私钥内容均拒绝', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-prepared-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const identity = projectIdentity('101', '.', 'example');
    const store = openProject(identity, '201', { home }); t.after(() => store.close());
    const context = { store, ui: { locale: 'en-US', password() { assert.fail('must not unlock prepared data'); } },
        snapshot: { repositoryId: policy.repositoryId, base: 'a'.repeat(40), actor: { id: '201' } } };
    saveSession(context, { operation: 'YANK' });
    const changes = new Map([['request.json', Buffer.from('{"signed":"exact bytes"}\n')], ['proof.bin', Buffer.from([0, 128, 255])]]);
    savePrepared(context, { changes, title: 'chore(plugin): test' });
    assert.deepEqual((await restorePrepared(context)).changes, changes);
    const updated = { ...context.snapshot, base: 'b'.repeat(40) };
    assert.deepEqual((await restorePrepared({ ...context, snapshot: updated })).changes, changes);
    assert.deepEqual(store.record.session.prepared.snapshot, context.snapshot);
    const restored = await restorePrepared({ ...context, snapshot: updated });
    savePrepared({ ...context, snapshot: updated }, restored);
    assert.deepEqual(store.record.session.prepared.snapshot, context.snapshot);
    for (const changed of [{ actor: { id: '202' } }, { repositoryId: '909' }]) {
        await assert.rejects(restorePrepared({ ...context, snapshot: { ...updated, ...changed } }), /SESSION_IDENTITY_CHANGED/u);
    }
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

test('真实向导恢复初始化也可重试或保存退出，原项目记录不丢失', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-resume-network-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const project = path.join(home, 'source'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    git(project, 'init'); git(project, 'add', '.pixivdownloader-plugin-project');
    git(project, '-c', 'user.name=Submission Test', '-c', 'user.email=submission@example.invalid', 'commit', '-m', 'test: source fixture');
    const store = openProject(projectIdentity('101', '.', 'example'), '201', { home });
    saveSession({ store, ui: { locale: 'zh-CN' } }, { operation: 'YANK', sourceCommit: git(project, 'rev-parse', 'HEAD') });
    const locator = sessionLocator(project, home); locator.bind(store, '201'); store.close();
    const original = locator.read();
    for (const failureAt of ['user', 'tree']) for (const action of ['retry', 'saveExit']) {
        let failed = false, retries = 0, reachedForm = false;
        const spoken = [];
        const call = endpoint => {
            if (!failed && (failureAt === 'user' ? endpoint === 'user' : endpoint.includes('/git/trees/'))) {
                failed = true; throw Object.assign(new Error('GITHUB_REQUEST_FAILED'), { github: true, attempts: 3 });
            }
            if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
            if (endpoint.endsWith('/git/ref/heads/' + policy.defaultBranch)) return { object: { sha: 'a'.repeat(40) } };
            if (endpoint === 'user') return { id: '201', login: 'author', type: 'User' };
            if (endpoint.includes('/git/trees/')) return { tree: [], truncated: false };
            assert.fail(endpoint);
        };
        const outcome = await runWizard(project, { call, stateHome: home, ui: { resume: true, locale: 'zh-CN', text: key => key,
            task: (_key, work) => work(), say: (...args) => spoken.push(args), close() {},
            select: key => {
                if (key === 'retrySubmission') { retries++; return action; }
                reachedForm = true; throw new Error('CANCELLED');
            } } });
        assert.equal(retries, 1); assert.equal(reachedForm, action === 'retry');
        assert.deepEqual(outcome, action === 'retry' ? { cancelled: true } : { saved: true });
        assert.deepEqual(locator.read(), original);
        assert(spoken.some(([key, details]) => key === 'requestFailed' && details.attempts === 3));
    }
});

test('恢复旧发布投稿先识别已发布版本，不访问过期候选且保留原始记录', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-published-'));
    const store = openProject(projectIdentity('101', '.', 'example'), '201', { home });
    t.after(() => { store.close(); fs.rmSync(home, { recursive: true }); });
    const project = path.join(home, 'source'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.pixivdownloader-plugin-project'), 'pixivdownloader-plugin-project-v1\n');
    git(project, 'init'); git(project, 'add', '.pixivdownloader-plugin-project');
    git(project, '-c', 'user.name=Submission Test', '-c', 'user.email=submission@example.invalid', 'commit', '-m', 'test: source fixture');
    git(project, 'remote', 'add', 'origin', 'https://github.com/example/plugin.git');
    const value = { pluginId: 'example', version: '2.3.4', owner: { accountId: '201', accountType: 'User', publisherId: 'author' },
        package: { sha256: 'a'.repeat(64) } };
    const published = { value };
    const context = { store, projectRoot: project, ui: { locale: 'en-US' },
        snapshot: { repositoryId: policy.repositoryId, base: 'a'.repeat(40), actor: { id: '201', type: 'User', login: 'author' } },
        state: { tree: new Map(), published: () => [published] },
        sdk: { document: (_kind, bytes) => ({ value: JSON.parse(bytes.toString('utf8')) }) },
        call: () => assert.fail('不应再查询候选、重新发布或写入远端') };
    saveSession(context, { operation: 'publish', sourceCommit: git(project, 'rev-parse', 'HEAD') });
    savePrepared(context, { title: 'feat(plugin): example', sourceRelease: { id: '1', tag: 'candidate', repository: 'example/plugin' },
        changes: new Map([['submissions/201/example/2.3.4.json', Buffer.from(JSON.stringify(value))]]) });
    const before = store.record;
    const restored = await restorePrepared({ ...context, snapshot: { ...context.snapshot, base: 'b'.repeat(40) } });
    assert.equal(restored.original, published);
    assert.deepEqual(store.record, before);
    published.value = { ...value, package: { sha256: 'c'.repeat(64) } };
    await assert.rejects(restorePrepared(context), /VERSION_DIGEST_CONFLICT/);
    assert.deepEqual(store.record, before);
    sessionLocator(project, home).bind(store, '201'); store.close();
    const files = new Map([['published/example/2.3.4.json', Buffer.from(JSON.stringify(value))],
        ['revocations.json', Buffer.from(JSON.stringify({ entries: [{ packageSha256: value.package.sha256, action: 'REVOKED' }] }))]]);
    const call = withRepositoryFiles((endpoint, options) => {
        assert(!options?.method);
        if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
        if (endpoint.endsWith('/git/ref/heads/master')) return { object: { sha: 'b'.repeat(40) } };
        if (endpoint === 'user') return context.snapshot.actor;
        if (endpoint === 'repos/example/plugin') return { id: '101', full_name: 'example/plugin', owner: { id: '201' } };
        if (endpoint === `${prefix}/releases/tags/author%2Fexample-v2.3.4`) throw Object.assign(new Error('GITHUB_NOT_FOUND'), { github: true, status: 404 });
        assert.fail('不应获取失效候选或重复提交: ' + endpoint);
    }, policy.repository, new Map([['b'.repeat(40), files]]));
    for (const candidate of [true, false]) {
        const pending = openProject(store.identity, '201', { home });
        pending.update({ session: { ...before.session, prepared: { ...before.session.prepared,
            ...(candidate ? {} : { sourceRelease: null, source: null }) } } });
        savePrepared({ ...context, store: pending }, { title: 'feat(plugin): example',
            ...(candidate ? { sourceRelease: before.session.prepared.sourceRelease } : {}), changes: restored.changes });
        pending.close();
        const notices = [];
        const workspace = fs.mkdtempSync(path.join(home, 'sdk-'));
        const result = await productionWizard(project, { call, stateHome: home,
            prepare: () => ({ ...context.sdk, workspace, invoke: command => {
                assert.equal(command.command, 'status'); return { state: 'ACTIVE' };
            } }), ui: { resume: true, locale: 'en-US', say: (key, details) => notices.push({ key, details }),
                task: (_key, work) => work(), close() {}, select: () => assert.fail('不应重新填写已发布投稿'),
                password: () => assert.fail('不应重新签名已发布投稿') } });
        assert.deepEqual(result.original, value, JSON.stringify({ candidate, result, notices }));
        assert.equal(notices.at(-1).key, 'versionREVOKED');
        assert.equal(notices.at(-1).details.publicationState, 'PUBLICATION_UNCONFIRMED');
        const completed = openProject(store.identity, '201', { home });
        assert.equal(completed.record.session, null); completed.close();
    }
});
