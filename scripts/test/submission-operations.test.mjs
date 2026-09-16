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
        assert.equal(f.notices.at(-1).value.code, 'NO_ELIGIBLE_VERSIONS');
        f.values.clear();
        await assert.rejects(prepareStatus(f.result, action), /WIZARD_MENU/);
        assert.equal(f.notices.at(-1).value.code, 'NO_OWNED_PLUGINS');
    }
    const f = context();
    await assert.rejects(prepareRotation(f.result), /WIZARD_MENU/);
    assert.equal(f.notices.at(-1).value.code, 'NO_OWNED_PUBLISHERS');
    for (const code of ['NO_OWNED_PUBLISHERS', 'NO_OWNED_PLUGINS', 'NO_REGISTERED_PLUGINS', 'NO_ELIGIBLE_VERSIONS', 'NO_WITHDRAWABLE_REQUESTS',
        'TRANSFER_SAME_OWNER', 'TRANSFER_RECIPIENT_START_REQUIRED', 'RECOVERY_EVIDENCE_REQUIRED', 'RECOVERY_EVIDENCE_DUPLICATED', 'KEY_ID_REUSED']) {
        assert.equal(errors[code].length, locales.length); assert.ok(errors[code].every(value => typeof value === 'string' && value.length > 0));
    }
});

test('版本操作只列出允许迁移的状态', async () => {
    const versions = ['ACTIVE', 'YANKED', 'REVOKED'].map((state, index) => ({ value: { version: String(index), package: { sha256: String(index) } }, state }));
    for (const [action, expected] of [['YANK', ['ACTIVE']], ['UNYANK', ['YANKED']], ['REVOKE', ['ACTIVE', 'YANKED']]]) {
        const f = context();
        f.result.state.currentStatus = (_plugin, version) => ({ state: versions[Number(version)].state });
        // bindHistory 也查询最新版本，此处返回无历史的单次查询。
        let calls = 0; f.result.state.published = () => ++calls === 1 ? [] : versions;
        f.result.ui.select = async (key, values) => {
            if (key === 'version') { assert.deepEqual(values.map(row => row.state), expected); throw new Error('SELECTION_VERIFIED'); }
            return values[0];
        };
        await assert.rejects(prepareStatus(f.result, action), /SELECTION_VERIFIED/);
    }
});

test('原维护者不被要求取得接收方私钥，目标身份变化的旧请求不再列出', async () => {
    const f = context();
    await assert.rejects(prepareTransfer(f.result), /WIZARD_MENU/);
    assert.equal(f.notices.at(-1).value.code, 'TRANSFER_RECIPIENT_START_REQUIRED');
    const request = { requestId: 'a'.repeat(64), payload: { pluginId: 'demo', from: f.binding.value.owner,
        to: { accountId: '101', accountType: 'User', publisherId: 'next' }, pluginBindingSha256: f.binding.sha256, targetPublisherRecordSha256: 'c'.repeat(64) } };
    f.values.set(`ownership-transfers/demo/${request.requestId}/proposal.json`, { value: request });
    f.values.set('publishers/101/next.json', { sha256: 'd'.repeat(64) });
    f.result.ui.select = async (key, items) => {
        assert.equal(key, 'proposal'); assert.deepEqual(items, [null]); throw new Error('STALE_REQUEST_FILTERED');
    };
    await assert.rejects(prepareTransfer(f.result), /STALE_REQUEST_FILTERED/);
});
