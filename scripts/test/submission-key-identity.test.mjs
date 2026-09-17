import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareSubmission, withEmergencyState } from './local-sdk.mjs';
import { signingTool, exportKey } from '../submission-signing.mjs';
import { signingKey } from '../submission-release.mjs';
import { prepareRotation } from '../submission-operations.mjs';
import { navigation } from '../submission-navigation.mjs';
import { openProject, projectIdentity } from '../submission-state.mjs';
import { publisherKeys } from '../submission-publisher-state.mjs';
import { root } from '../sdk.mjs';
import { additions, errors } from '../submission-messages.mjs';
import { locales } from '../submission-ui.mjs';

let sdk, sign, directory;
before(() => {
    sdk = prepareSubmission();
    sign = signingTool(sdk);
    // 私钥夹具与真实选择一样位于源码和系统临时目录之外。
    directory = fs.mkdtempSync(path.join(path.dirname(root), 'key-identity-test-'));
});
after(() => {
    sign?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function externalKey() {
    const folder = fs.mkdtempSync(path.join(directory, 'external-'));
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicFile = path.join(folder, 'public-key.pem'), privateFile = path.join(folder, 'private-key.pem');
    fs.writeFileSync(publicFile, pair.publicKey.export({ format: 'pem', type: 'spki' }));
    fs.writeFileSync(privateFile, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    return { publicFile, privateFile, directory: folder };
}

function project(t) {
    const home = fs.mkdtempSync(path.join(sdk.workspace, 'history-'));
    const identity = projectIdentity('101', '.', 'sample');
    let store = openProject(identity, '201', { home });
    t.after(() => store.close());
    return { get store() { return store; }, reopen() { store.close(); store = openProject(identity, '201', { home }); } };
}

function form(context, files, options = {}) {
    const prompts = [], notices = [];
    const ui = { locale: 'en-US', text: key => key, say: (key, value) => notices.push({ key, value }),
        select: async (key, values) => key === 'keyAction' ? options.action ?? 'existingKey'
            : key === 'keyProtection' ? 'plainKey' : values[0],
        confirm: async key => key !== 'optionalKey' || Boolean(options.oldProof),
        ask: async (key, initial, validate) => {
            prompts.push({ key, initial });
            if (key === 'keyId') options.checkId?.(initial, validate);
            if (key === 'publicKey') options.checkPublic?.(validate);
            const value = key === 'publicKey' ? files.publicFile : key === 'privateKey' ? files.privateFile ?? initial
                : key === 'keyDirectory' ? directory : key === 'explanation' ? 'Replace the signing key' : initial;
            await validate?.(value);
            return value;
        } };
    const nav = navigation(ui, () => context.store, { history: options.history ?? [], onChange: options.onChange });
    context.ui = nav.ui;
    return { nav, prompts, notices };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test('真实配对后跨工程复用发布者密钥，旧钥证明更新路径且错误配对不污染记录', async t => {
    const home = fs.mkdtempSync(path.join(sdk.workspace, 'publisher-history-'));
    const owner = { accountId: '201', accountType: 'User', publisherId: 'sample' };
    const stores = [openProject(projectIdentity('101', '.', 'first'), '201', { home }),
        openProject(projectIdentity('102', '.', 'second'), '201', { home })];
    t.after(() => stores.forEach(store => store.close()));
    const context = { sdk, sign, call: withEmergencyState(), projectRoot: root, store: stores[0], snapshot: { actor: { id: '201', type: 'User' } },
        bindPublisher(value) { this.keyStore = publisherKeys(value, '201', { home }); } };
    context.bindPublisher(owner);
    const old = externalKey();
    let f = form(context, old);
    const selected = await f.nav.run(() => signingKey(context));
    assert.equal(stores[0].key(selected.fingerprint), undefined);
    const publisher = { value: { publisherId: owner.publisherId, githubAccount: { id: owner.accountId, type: owner.accountType },
        signingKeys: [{ ...selected.key, state: 'ACTIVE' }] }, sha256: 'a'.repeat(64) };
    const tree = new Map([['publishers/201/sample.json', publisher]]);
    context.state = { tree, read: file => tree.get(file) }; context.store = stores[1];
    const correctedPrivate = path.join(old.directory, 'verified-private.pem');
    fs.copyFileSync(old.privateFile, correctedPrivate);
    f = form(context, { privateFile: correctedPrivate }, { action: 'generateKey', oldProof: true });
    const result = await f.nav.run(() => prepareRotation(context));
    const request = JSON.parse([...result.changes.values()][0]);
    assert.equal(f.prompts.find(item => item.key === 'privateKey').initial, old.privateFile);
    const shared = publisherKeys(owner, '201', { home });
    assert.equal(shared.key(selected.fingerprint).privateFile, correctedPrivate);
    assert.equal(shared.record.key.keyId, request.payload.newKey.keyId);
    context.store = stores[0]; context.bindPublisher(owner);
    stores[0].remember('publicKey:0', old.publicFile);
    f = form(context, shared.record.key);
    assert.equal((await f.nav.run(() => signingKey(context))).key.keyId, request.payload.newKey.keyId);
    assert.equal(f.prompts.find(item => item.key === 'publicKey').initial, shared.record.key.publicFile);
    const profile = path.join(shared.folder, 'profile.json'), original = fs.readFileSync(profile);
    f = form(context, { publicFile: old.publicFile, privateFile: shared.record.key.privateFile });
    await assert.rejects(f.nav.run(() => signingKey(context)), /KEY_PAIR_MISMATCH/);
    assert.deepEqual(fs.readFileSync(profile), original);
    f = form(context, { publicFile: path.join(old.directory, 'missing.pem') });
    await assert.rejects(f.nav.run(() => signingKey(context)), /KEY_PATH_NOT_FOUND/);
    assert.deepEqual(fs.readFileSync(profile), original);
});

test('外部生成的密钥首次导入自动分配 UUID；换路径与重新启动仍按公钥指纹恢复', async t => {
    const p = project(t), first = externalKey(), second = externalKey();
    const context = { sdk, sign, projectRoot: root, store: p.store };
    let f = form(context, first);
    const a = await f.nav.run(() => signingKey(context));
    assert.match(a.key.keyId, uuid);
    assert(f.notices.some(item => item.key === 'keyIdHelp'));
    assert.equal(p.store.answer('keyId:0'), undefined);
    // 旧版只有最后一条密钥记录，迁移前同样不能给新公钥复用旧标识。
    p.store.close();
    const profile = path.join(p.store.folder, 'profile.json');
    const data = JSON.parse(fs.readFileSync(profile, 'utf8'));
    delete data.actors['201'].keys;
    fs.writeFileSync(profile, JSON.stringify(data));
    p.reopen(); context.store = p.store;
    f = form(context, second, { checkId: (initial, validate) => {
        assert.match(initial, uuid);
        assert.throws(() => validate(a.key.keyId), /KEY_ID_REUSED/u);
    } });
    const b = await f.nav.run(() => signingKey(context));
    assert.notEqual(a.key.keyId, b.key.keyId);
    assert.equal(p.store.key(a.fingerprint).keyId, a.key.keyId);
    assert.equal(p.store.key(b.fingerprint).keyId, b.key.keyId);
    const moved = { ...first, publicFile: path.join(first.directory, 'renamed-public.pem') };
    fs.copyFileSync(first.publicFile, moved.publicFile);
    p.reopen(); context.store = p.store;
    f = form(context, moved, { checkId: (initial, validate) => {
        assert.equal(initial, a.key.keyId);
        assert.throws(() => validate(crypto.randomUUID()), /KEY_ID_MISMATCH/u);
    } });
    assert.equal((await f.nav.run(() => signingKey(context))).key.keyId, a.key.keyId);
    assert.equal(p.store.key(a.fingerprint).publicFile, moved.publicFile);
    assert(!fs.readFileSync(path.join(p.store.folder, 'profile.json'), 'utf8').includes('BEGIN PRIVATE KEY'));
});

test('新生成密钥不会继承历史输入，换钥冲突停留在字段内且旧密钥记录保留', async t => {
    const p = project(t), old = externalKey();
    const { fingerprint, ...key } = exportKey(sdk, sign, old.publicFile, crypto.randomUUID());
    p.store.update({ key: { ...old, fingerprint, keyId: key.keyId } });
    p.store.remember('keyId:0', key.keyId);
    p.store.remember('privateKey:0', old.privateFile);
    const publisher = { value: { publisherId: 'sample', githubAccount: { id: '201', type: 'User' }, signingKeys: [{ ...key, state: 'ACTIVE' }] }, sha256: 'a'.repeat(64) };
    const tree = new Map([['publishers/201/sample.json', publisher]]);
    const context = { sdk, sign, call: withEmergencyState(), projectRoot: root, store: p.store, snapshot: { actor: { id: '201', type: 'User' } },
        state: { tree, read: file => tree.get(file) } };
    const f = form(context, {}, { action: 'generateKey', oldProof: true, checkId: (initial, validate) => {
        assert.match(initial, uuid); assert.notEqual(initial, key.keyId);
        assert.throws(() => validate(key.keyId), /KEY_ID_REUSED/u);
    } });
    const result = await f.nav.run(() => prepareRotation(context));
    const request = JSON.parse([...result.changes.values()][0]);
    assert.notEqual(request.payload.newKey.keyId, key.keyId);
    assert.notEqual(request.payload.newKey.publicKeySpkiBase64, key.publicKeySpkiBase64);
    assert.equal(request.proofs.newKey.keyId, request.payload.newKey.keyId);
    assert.equal(request.proofs.oldKey.keyId, key.keyId);
    assert.equal(f.prompts.find(item => item.key === 'privateKey').initial, old.privateFile);
    assert.equal(p.store.key(fingerprint).privateFile, old.privateFile);
    assert(!f.notices.some(item => item.key === 'operationUnavailable'));
    const newRecord = p.store.record.key;
    p.reopen(); context.store = p.store;
    const again = form(context, newRecord, { checkPublic: validate => assert.throws(() => validate(old.publicFile), /KEY_PUBLIC_REUSED/u) });
    assert.equal((await again.nav.run(() => signingKey(context, [key], { rotation: true }))).key.keyId, newRecord.keyId);
});

test('无缓存时从登记公钥恢复历史标识，并修复旧缓存的新公钥与旧标识错配', async t => {
    const p = project(t), old = externalKey(), next = externalKey();
    const { fingerprint, ...registered } = exportKey(sdk, sign, old.publicFile, 'historical:key');
    const context = { sdk, sign, projectRoot: root, store: p.store };
    let f = form(context, old);
    assert.equal((await f.nav.run(() => signingKey(context, [registered]))).key.keyId, registered.keyId);
    const newFingerprint = exportKey(sdk, sign, next.publicFile, 'temporary').fingerprint;
    p.store.close();
    const profile = path.join(p.store.folder, 'profile.json');
    const data = JSON.parse(fs.readFileSync(profile, 'utf8'));
    delete data.actors['201'].keys;
    data.actors['201'].key = { ...next, fingerprint: newFingerprint, keyId: registered.keyId };
    data.actors['201'].answers['keyId:0'] = registered.keyId;
    fs.writeFileSync(profile, JSON.stringify(data));
    p.reopen(); context.store = p.store;
    f = form(context, next);
    const selected = await f.nav.run(() => signingKey(context, [registered], { rotation: true }));
    assert.match(selected.key.keyId, uuid); assert.notEqual(selected.key.keyId, registered.keyId);
    assert.equal(p.store.key(newFingerprint).keyId, selected.key.keyId);
    f = form(context, old);
    assert.equal((await f.nav.run(() => signingKey(context, [registered]))).key.keyId, registered.keyId);
    assert.equal(p.store.key(fingerprint).keyId, registered.keyId);
});

test('恢复记录绑定字段对象，不把上一公钥的回答或确认套给新公钥', async t => {
    const p = project(t);
    const files = [externalKey(), externalKey()];
    const context = { sdk, sign, projectRoot: root, store: p.store };
    let history = [];
    const first = form(context, files[0], { onChange: value => { history = value; } });
    const a = await first.nav.run(() => signingKey(context));
    // 路径输入保持相同，原文件被另一把公钥替换，指纹变化仍必须重新询问。
    fs.copyFileSync(files[1].publicFile, files[0].publicFile);
    fs.copyFileSync(files[1].privateFile, files[0].privateFile);
    const second = form(context, files[0], { history });
    const b = await second.nav.run(() => signingKey(context));
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.notEqual(a.key.keyId, b.key.keyId);
    assert.equal(second.prompts.filter(item => item.key === 'keyId').length, 1);
});

test('新密钥生成后保存退出不覆盖原记录，恢复时复用文件和 UUID', async t => {
    const p = project(t), old = externalKey();
    const context = { sdk, sign, projectRoot: root, store: p.store };
    let f = form(context, old);
    const selected = await f.nav.run(() => signingKey(context));
    const oldRecord = p.store.record.key;
    f = form(context, {}, { action: 'generateKey', checkId() { throw new Error('WIZARD_SAVE'); } });
    await assert.rejects(f.nav.run(() => signingKey(context)), /WIZARD_SAVE/u);
    assert.deepEqual(p.store.record.key, oldRecord);
    const generated = p.store.record.session.generatedKey;
    assert.notEqual(generated.keyId, selected.key.keyId);
    const publicFile = path.join(generated.directory, 'public-key.pem');
    const publicBytes = fs.readFileSync(publicFile);
    p.reopen();
    const resumed = { sdk, sign, projectRoot: root, store: p.store, generatedKey: p.store.record.session.generatedKey };
    f = form(resumed, {}, { action: 'generateKey' });
    const result = await f.nav.run(() => signingKey(resumed));
    assert.equal(result.key.keyId, generated.keyId);
    assert.deepEqual(fs.readFileSync(publicFile), publicBytes);
    assert.equal(p.store.key(selected.fingerprint).keyId, selected.key.keyId);
});

test('keyId 说明及字段错误覆盖全部向导语言', () => {
    for (const values of [additions.keyIdHelp, errors.KEY_ID_REUSED, errors.KEY_ID_MISMATCH, errors.KEY_PUBLIC_REUSED]) {
        assert.equal(values.length, locales.length);
        assert(values.every(value => typeof value === 'string' && value.trim()));
    }
});
