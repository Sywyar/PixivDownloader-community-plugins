import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../sdk.mjs';
import { keyProjects } from '../emergency-state.mjs';
import { keyLabel } from '../submission-emergency.mjs';
import { ownershipState, publicationState, requestCurrentState } from '../submission-current-state.mjs';
import { presentOriginal, requestedVersionState } from '../submission-version-state.mjs';
import { formalTag, packageName } from '../apply-generation.mjs';
import { locales, localizedText } from '../submission-ui.mjs';

const owner = { accountId: '101', accountType: 'User', publisherId: 'first' };
const recipient = { accountId: '202', accountType: 'User', publisherId: 'second' };
const old = { keyId: 'old', state: 'RETIRED', publicKeySpkiBase64: 'b2xk' };
const key = { keyId: 'current', state: 'ACTIVE', publicKeySpkiBase64: 'bmV3' };
const encode = value => Buffer.from(JSON.stringify(value));

function fixture() {
    const records = new Map(), notices = [];
    const put = (file, value) => { records.set(file, encode(value)); return file; };
    const binding = put('plugin-bindings/example.json', { pluginId: 'example', owner: recipient });
    const publisher = put('publishers/101/first.json', { publisherId: 'first', githubAccount: { id: '101', type: 'User' }, signingKeys: [old, key] });
    const value = { pluginId: 'example', version: '1.2.3', owner, sourceCommit: 'a'.repeat(40),
        package: { sha256: 'b'.repeat(64), expectedSize: 123, url: 'https://example.invalid/plugin.jar', signature: { keyId: key.keyId } },
        communitySignature: { keyId: 'community' } };
    put('published/example/1.2.3.json', value);
    put('published/example/1.2.2.json', { ...value, version: '1.2.2', package: { ...value.package, signature: { keyId: old.keyId } } });
    put('revocations.json', { entries: [{ pluginId: 'example', version: '1.2.2', action: 'REVOKED' }] });
    put('revocations/restrictions.json', []);
    const state = { tree: records, raw: file => records.get(file) ?? null,
        read: file => records.has(file) ? { value: JSON.parse(records.get(file)), sha256: hash(records.get(file)) } : null,
        published: pluginId => [...records].filter(([file]) => file.startsWith(`published/${pluginId}/`)).map(([file]) => state.read(file)),
        reference: ref => records.get(ref.path), currentStatus: (_id, _version, _digest, request) => ({ state: request ? 'ACTIVE' : 'YANKED' }) };
    const context = { state, snapshot: { actor: { id: '101', type: 'User' } }, emergency: { readBlock: () => null },
        sdk: { document: (_kind, bytes) => ({ value: JSON.parse(bytes), sha256: hash(bytes) }) },
        call: (endpoint, options = {}) => { assert.equal(options.method ?? 'GET', 'GET'); throw Object.assign(new Error('GITHUB_NOT_FOUND'), { github: true, status: 404 }); },
        ui: { text: text => localizedText('en-US', text), say: (name, value) => notices.push({ name, value }) } };
    return { ...context, notices, records, put, binding, publisher, value };
}

test('密钥关联区分当前归属与历史签名，转移不退役密钥，撤销版本与泄露状态并列显示', () => {
    const f = fixture(), before = structuredClone(key);
    f.put('plugin-bindings/another.json', { pluginId: 'another', owner });
    const projects = keyProjects(f.state, owner, key);
    assert.deepEqual(projects.map(row => [row.pluginId, row.relationship]), [['another', 'CURRENT_OWNER'], ['example', 'OWNERSHIP_TRANSFERRED']]);
    assert.equal(projects[1].currentOwner.publisherId, 'second');
    assert.equal(keyProjects(f.state, owner, old)[0].versions[0].currentState, 'REVOKED');
    f.emergency.readBlock = () => ({});
    for (const locale of locales) {
        f.ui.text = text => localizedText(locale, text);
        const label = keyLabel(f, owner, old);
        for (const state of ['RETIRED', 'DECLARED_COMPROMISED', 'OWNERSHIP_TRANSFERRED', 'REVOKED']) {
            assert(label.includes(f.ui.text('option.' + state)), `${locale}: ${state}`);
        }
        assert(label.includes('second')); assert(label.includes('1.2.2'));
    }
    assert.deepEqual(key, before);
    assert.equal(ownershipState(f, 'example').canManage, false);
});

test('重复投稿展示当前归属和公开状态，登记与活动状态不等于 Release 已公开', () => {
    const f = fixture();
    f.state.currentStatus = () => ({ state: 'ACTIVE' });
    presentOriginal(f, { value: f.value });
    assert.equal(f.notices[0].value.currentState, 'ACTIVE');
    assert.deepEqual(f.notices[0].value.historicalOwner, owner);
    assert.deepEqual(f.notices[0].value.currentOwner, recipient);
    assert.equal(f.notices[0].value.canManage, false);
    assert.equal(f.notices[0].value.publicationState, 'PUBLICATION_UNCONFIRMED');
    const release = { id: 3, tag_name: formalTag(f.value), published_at: '2026-01-01T00:00:00Z', draft: false };
    let asset = { id: 4, name: packageName(f.value), state: 'uploaded', size: 123, digest: `sha256:${f.value.package.sha256}` };
    const call = endpoint => endpoint.includes('/assets?') ? [[asset]] : release;
    assert.equal(publicationState(f.value, call).publicationState, 'PUBLICATION_PUBLIC');
    release.draft = true;
    assert.equal(publicationState(f.value, call).publicationState, 'PUBLICATION_DRAFT');
    release.draft = false; asset = { ...asset, digest: 'sha256:wrong' };
    assert.equal(publicationState(f.value, call).publicationState, 'PUBLICATION_UNAVAILABLE');
    for (const code of ['GITHUB_NOT_FOUND', 'GITHUB_ACCESS_DENIED', 'GITHUB_TIMEOUT']) {
        const result = publicationState(f.value, () => { throw Object.assign(new Error(code), { github: true }); });
        assert.equal(result.publicationState, 'PUBLICATION_UNCONFIRMED'); assert.equal(result.code, code);
    }
    assert.throws(() => publicationState(f.value, () => { throw new Error('WIZARD_SAVE'); }), /WIZARD_SAVE/);
});

test('旧请求恢复显示 Draft、绑定变化、换钥、泄露和前序版本变化，原请求字节保持不变', () => {
    const f = fixture();
    const proposal = { payload: { pluginId: 'example', from: owner, to: recipient, pluginBindingSha256: 'old-binding',
        targetPublisherRecordSha256: null, targetKey: key }, proofs: { targetKey: { keyId: key.keyId } } };
    const changes = new Map([['ownership-transfers/example/request/proposal.json', encode(proposal)]]);
    const before = Buffer.from([...changes.values()][0]);
    presentOriginal(f, { reused: true, draft: true, url: 'https://example.invalid/pr/1' }, changes);
    assert(f.notices.some(row => row.name === 'requestDraft' && row.value.url.endsWith('/1')));
    assert(f.notices.some(row => row.name === 'requestStale' && row.value.code === 'BINDING_CONFLICT'));
    assert(!f.notices.some(row => row.name === 'requestPending'));
    f.put('publishers/202/second.json', { signingKeys: [{ ...key, keyId: 'next' }] });
    f.emergency.readBlock = () => ({});
    const codes = requestCurrentState(f, changes)[0].issues.map(row => row.code);
    for (const code of ['BINDING_CHANGED', 'TARGET_PUBLISHER_CHANGED', 'TARGET_KEY_CHANGED', 'KEY_DECLARED_COMPROMISED']) assert(codes.includes(code));
    assert.deepEqual([...changes.values()][0], before);
    const submission = { publisherId: 'first', pluginId: 'example', version: '1.2.4', package: { signature: { keyId: 'old' } }, source: { previousReviewedCommit: null } };
    const pending = requestCurrentState(f, new Map([['submissions/101/example/1.2.4.json', encode(submission)]]))[0];
    for (const code of ['TARGET_KEY_CHANGED', 'PREVIOUS_SOURCE_CHANGED', 'BINDING_CONFLICT']) assert(pending.issues.some(row => row.code === code));
});

test('旧换钥及转移已生效记录旁展示后续换钥和再次转移的当前事实', () => {
    const f = fixture();
    const rotation = { payload: { githubAccount: { id: '101', type: 'User' }, publisherId: 'first', oldKeyId: 'older', newKey: old } };
    const path = f.put('rotation.json', rotation);
    presentOriginal(f, { value: { action: 'PUBLISHER_KEY_ROTATION', requestRef: { path } } });
    assert(f.notices.some(row => row.name === 'keyContext' && row.value.some(label => label.includes(key.keyId))));
    const transfer = f.put('transfer.json', { payload: { pluginId: 'example', from: owner, to: recipient } });
    const third = { ...recipient, accountId: '303', publisherId: 'third' };
    f.put(f.binding, { owner: third });
    presentOriginal(f, { value: { action: 'OWNERSHIP_TRANSFER', requestRef: { path: transfer } } });
    assert(f.notices.some(row => row.name === 'currentRequestState' && row.value.currentOwner.publisherId === 'third'));
    assert(f.notices.some(row => row.name === 'transferVersionStates'));
});

test('待处理换钥请求核对当前登记与活动密钥，未变化的请求保留待处理提示', () => {
    const f = fixture();
    const request = { payload: { githubAccount: { id: '101', type: 'User' }, publisherId: 'first',
        publisherRecordSha256: f.state.read(f.publisher).sha256, oldKeyId: key.keyId,
        newKey: { ...key, keyId: 'next', publicKeySpkiBase64: 'bmV4dA==' } }, proofs: { oldKey: { keyId: key.keyId } } };
    const changes = new Map([['key-rotations/101/first/request.json', encode(request)]]);
    assert.deepEqual(requestCurrentState(f, changes)[0].issues, []);
    presentOriginal(f, { reused: true, url: 'https://example.invalid/pr/1' }, changes);
    assert(f.notices.some(row => row.name === 'requestPending'));
    f.put(f.publisher, { signingKeys: [{ ...key, keyId: 'new-current' }] });
    assert.deepEqual(requestCurrentState(f, changes)[0].issues.map(row => row.code), ['PUBLISHER_CHANGED', 'TARGET_KEY_CHANGED']);
});

test('UNYANK 预览保留匹配的独立限制及原因，非独立和其它版本限制不残留', () => {
    const f = fixture(), request = { payload: { action: 'UNYANK' } };
    const restriction = { action: 'YANKED', reasonCode: 'LICENSE_ISSUE', pluginId: 'example', version: '1.2.3' };
    f.put('revocations/restrictions.json', [{ communityIndependent: true, entry: restriction },
        { communityIndependent: false, entry: { ...restriction, action: 'REVOKED' } },
        { communityIndependent: true, entry: { ...restriction, version: '9.9.9', action: 'REVOKED' } }]);
    const result = requestedVersionState(f.state, { value: f.value }, request);
    assert.equal(result.requestedState, 'YANKED');
    assert.equal(result.remainingRestrictions.length, 1);
    assert.equal(result.remainingRestrictions[0].reasonCode, 'LICENSE_ISSUE');
    f.put('revocations/restrictions.json', []);
    assert.equal(requestedVersionState(f.state, { value: f.value }, request).requestedState, 'ACTIVE');
    f.records.delete('revocations/restrictions.json');
    assert.throws(() => requestedVersionState(f.state, { value: f.value }, request), /REVOCATIONS_BASELINE_MISSING/);
});

test('同一版本再次下架后，旧 UNYANK 显示其决定引用已过时', () => {
    const f = fixture();
    f.put(f.binding, { owner });
    f.state.currentStatus = () => ({ state: 'YANKED', decisionSha256: 'new-decision' });
    const request = { payload: { owner, pluginId: 'example', version: '1.2.3', action: 'UNYANK',
        pluginBindingSha256: f.state.read(f.binding).sha256, packageSha256: f.value.package.sha256, yankedDecisionSha256: 'old-decision' }, proofs: {} };
    const changes = new Map([['version-status-requests/101/example/1.2.3/request.json', encode(request)]]);
    assert.deepEqual(requestCurrentState(f, changes)[0].issues, [{ code: 'YANK_DECISION_CHANGED' }]);
});
