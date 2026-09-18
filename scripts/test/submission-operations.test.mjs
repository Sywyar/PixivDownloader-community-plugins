import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRotation, prepareStatus, prepareTransfer, confirmRevocation } from '../submission-operations.mjs';
import { navigation } from '../submission-navigation.mjs';
import { errors } from '../submission-messages.mjs';
import { locales } from '../submission-ui.mjs';

function context() {
    const values = new Map(), notices = [], choices = [];
    const owner = { accountId: '101', accountType: 'User', publisherId: 'original' };
    const binding = { sha256: 'b'.repeat(64), value: { pluginId: 'demo', owner } };
    values.set('plugin-bindings/demo.json', binding);
    const result = { projectRoot: process.cwd(), snapshot: { actor: { id: '101', type: 'User', login: 'original' } },
        state: { tree: values, read: file => values.get(file) ?? null, published: () => [], currentStatus: () => ({ state: 'ACTIVE' }) },
        ui: { text: key => key, say: (key, value) => notices.push({ key, value }), select: async (key, items) => { choices.push({ key, items }); return items[0]; },
            ask: async key => key === 'targetLogin' ? 'recipient' : 'recipient', confirm: async () => true },
        sdk: { invoke: () => ({ valid: true }) }, call: () => ({ id: 202, type: 'User', login: 'recipient' }) };
    return { result, values, binding, notices, choices };
}

test('撤销最终确认校验完整插件版本，保存恢复不复用或预填该许可', async () => {
    const changes = new Map([['request.json', Buffer.from(JSON.stringify({ payload: { pluginId: 'demo', version: '1.0.0', packageSha256: 'a'.repeat(64) } }))]]);
    let history = [], asked = 0, remembered = 0;
    const ui = { say() {}, ask: async (key, initial, validate) => {
        assert.equal(key, 'revokeIdentity'); assert.equal(initial, '');
        assert.throws(() => validate('demo'), /REVOKE_CONFIRMATION_MISMATCH/);
        validate('demo@1.0.0'); asked++; return 'demo@1.0.0';
    } };
    for (let run = 0; run < 2; run++) {
        const form = navigation(ui, () => ({ folder: 'project', remember() { remembered++; } }), { history, onChange: value => { history = value; } });
        await confirmRevocation(form.ui, { operation: 'REVOKE', requestPath: 'request.json' }, changes);
    }
    assert.equal(asked, 2); assert.equal(remembered, 0); assert.deepEqual(history, []);
});

test('无发布者、无插件及无适用版本分别给出原因并返回菜单', async () => {
    for (const action of ['YANK', 'UNYANK', 'REVOKE']) {
        const f = context();
        await assert.rejects(prepareStatus(f.result, action), /WIZARD_MENU/);
        assert.equal(f.notices.at(-1).value.code, 'NO_PUBLISHED_VERSIONS');
        f.values.clear();
        await assert.rejects(prepareStatus(f.result, action), /WIZARD_MENU/);
        assert.equal(f.notices.at(-1).value.code, 'NO_OWNED_PLUGINS');
    }
    const f = context();
    await assert.rejects(prepareRotation(f.result), /WIZARD_MENU/);
    assert.equal(f.notices.at(-1).value.code, 'NO_OWNED_PUBLISHERS');
    for (const code of ['NO_OWNED_PUBLISHERS', 'NO_OWNED_PLUGINS', 'NO_REGISTERED_PLUGINS', 'NO_PUBLISHED_VERSIONS', 'NO_ELIGIBLE_VERSIONS', 'NO_WITHDRAWABLE_REQUESTS',
        'TRANSFER_SAME_OWNER', 'TRANSFER_RECIPIENT_START_REQUIRED', 'RECOVERY_EVIDENCE_REQUIRED', 'RECOVERY_EVIDENCE_DUPLICATED', 'KEY_ID_REUSED']) {
        assert.equal(errors[code].length, locales.length); assert.ok(errors[code].every(value => typeof value === 'string' && value.length > 0));
    }
});

test('泄露恢复先核对紧急声明，未生效时不准备新密钥或询问说明', async () => {
    for (const fromRelease of [false, true]) for (const declared of [false, true]) {
        const f = context(), owner = f.binding.value.owner;
        const key = { keyId: 'current', publicKeySpkiBase64: Buffer.from('public-key').toString('base64'), state: 'ACTIVE' };
        const existing = { sha256: 'a'.repeat(64), value: { publisherId: owner.publisherId,
            githubAccount: { id: owner.accountId, type: owner.accountType }, signingKeys: [key] } };
        f.values.set('publishers/101/original.json', existing);
        let checked = false;
        f.result.emergency = { readBlock: () => { checked = true; return declared ? {} : null; } };
        f.result.ui.ask = async () => assert.fail('紧急声明检查前不应询问说明或密钥路径');
        f.result.ui.select = async (field, values) => {
            if (field === 'selectPublisher') return values[0];
            if (field === 'reason') return 'KEY_COMPROMISED';
            assert.equal(field, 'keyAction');
            assert.equal(checked, true);
            assert.equal(declared, true);
            throw new Error('KEY_SELECTION_REACHED');
        };
        const rotation = fromRelease ? { owner, existing, selectedKey: { key } } : undefined;
        await assert.rejects(prepareRotation(f.result, rotation), declared ? /KEY_SELECTION_REACHED/ : /WIZARD_MENU/);
        assert.equal(checked, true);
        if (!declared) assert.equal(f.notices.at(-1).value.code, 'KEY_COMPROMISE_DECLARATION_REQUIRED');
    }
});

test('版本操作只列出允许迁移的状态', async () => {
    const versions = ['ACTIVE', 'YANKED', 'REVOKED'].map((state, index) => ({ value: { version: String(index), package: { sha256: String(index) } }, state }));
    for (const [action, expected] of [['YANK', ['ACTIVE']], ['UNYANK', ['YANKED']], ['REVOKE', ['ACTIVE', 'YANKED']]]) {
        const f = context();
        f.result.state.currentStatus = (_plugin, version) => ({ state: versions[Number(version)].state });
        // bindHistory 也查询最新版本，此处返回无历史的单次查询。
        let calls = 0; f.result.state.published = () => ++calls === 1 ? [] : versions;
        f.result.ui.select = async (key, values, label) => {
            if (key === 'version') {
                assert.deepEqual(values.map(row => row.state), expected);
                for (const row of values) assert(label(row).includes('(' + row.state + ')'));
                assert(f.notices.some(notice => notice.key === 'effect' + action));
                throw new Error('SELECTION_VERIFIED');
            }
            return values[0];
        };
        await assert.rejects(prepareStatus(f.result, action), /SELECTION_VERIFIED/);
    }
});

test('无可操作版本时展示实际状态，社区独立撤销不能被恢复选项忽略', async () => {
    for (const action of ['YANK', 'UNYANK', 'REVOKE']) {
        const f = context();
        const record = { value: { pluginId: 'demo', version: '2.0.0', package: { sha256: 'a'.repeat(64) } } };
        let calls = 0; f.result.state.published = () => ++calls === 1 ? [] : [record];
        f.result.state.currentStatus = () => ({ state: 'YANKED' });
        f.values.set('revocations.json', {});
        f.result.state.raw = () => Buffer.from(JSON.stringify({ entries: [{ packageSha256: record.value.package.sha256, action: 'REVOKED' }] }));
        await assert.rejects(prepareStatus(f.result, action), /WIZARD_MENU/);
        const notice = f.notices.at(-1).value;
        assert.equal(notice.code, 'NO_ELIGIBLE_VERSIONS');
        assert.equal(notice.operation, action);
        assert.equal(notice.versions[0].currentState, 'REVOKED');
        assert(!f.choices.some(choice => choice.key === 'version'));
    }
});

test('社区独立隐藏而非作者隐藏的版本不提供 UNYANK', async () => {
    const f = context();
    let calls = 0;
    f.result.state.published = () => ++calls === 1 ? [] : [{ value: { pluginId: 'demo', version: '2.0.0', package: { sha256: 'a'.repeat(64) } } }];
    f.values.set('revocations.json', {});
    f.result.state.raw = () => Buffer.from(JSON.stringify({ entries: [{ pluginId: 'demo', action: 'YANKED' }] }));
    await assert.rejects(prepareStatus(f.result, 'UNYANK'), /WIZARD_MENU/);
    assert.equal(f.notices.at(-1).value.versions[0].currentState, 'YANKED');
    assert(!f.choices.some(choice => choice.key === 'version'));
});

test('原维护者不被要求取得接收方私钥，目标身份变化的旧请求不再列出', async () => {
    const f = context();
    f.result.ui.select = async (key, items) => key === 'proposal' ? 'handoff' : items[0];
    f.result.ui.ask = async () => assert.fail('转出指引不询问接收方身份或私钥');
    await assert.rejects(prepareTransfer(f.result), /WIZARD_MENU/);
    assert.equal(f.notices.at(-1).key, 'transferHandoffHelp');
    assert.equal(f.notices.at(-1).value.pluginId, 'demo');
    const request = { requestId: 'a'.repeat(64), payload: { pluginId: 'demo', from: f.binding.value.owner,
        to: { accountId: '101', accountType: 'User', publisherId: 'next' }, pluginBindingSha256: f.binding.sha256, targetPublisherRecordSha256: 'c'.repeat(64) } };
    f.values.set(`ownership-transfers/demo/${request.requestId}/proposal.json`, { value: request });
    f.values.set('publishers/101/next.json', { sha256: 'd'.repeat(64) });
    f.result.ui.select = async (key, items) => {
        assert.equal(key, 'proposal'); assert.deepEqual(items, [null, 'handoff']); throw new Error('STALE_REQUEST_FILTERED');
    };
    await assert.rejects(prepareTransfer(f.result), /STALE_REQUEST_FILTERED/);
});

test('接收申请复用本人账号和已登记发布者标识，不允许代填第三方账号', async () => {
    const f = context();
    f.result.snapshot.actor = { id: '202', type: 'User', login: 'recipient' };
    f.values.set('publishers/202/registered.json', { value: { publisherId: 'registered', signingKeys: [] } });
    let asked = false;
    f.result.ui.ask = async (key, suggestion) => {
        assert.equal(key, 'recipientPublisher'); assert.equal(suggestion, 'registered'); asked = true; return suggestion;
    };
    f.result.ui.select = async (key, items) => {
        if (key === 'keyAction') { assert.equal(asked, true); throw new Error('RECIPIENT_KEY_REACHED'); }
        return items[0];
    };
    f.result.bindPublisher = owner => assert.deepEqual(owner, { accountId: '202', accountType: 'User', publisherId: 'registered' });
    await assert.rejects(prepareTransfer(f.result), /RECIPIENT_KEY_REACHED/);
    assert(f.notices.some(row => row.key === 'transferHelp'));
    assert(f.notices.some(row => row.key === 'transferRecipientHelp'));
});
