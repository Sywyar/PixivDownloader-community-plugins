import test from 'node:test';
import assert from 'node:assert/strict';
import { versionState, presentOriginal, requestVersionNotice, transferVersionNotice } from '../submission-version-state.mjs';
import { versionAvailable } from '../submission-check.mjs';
import { confirmRevocation } from '../submission-operations.mjs';

function context(current = 'ACTIVE', restrictions = []) {
    const record = { value: { pluginId: 'example', version: '2.3.4', package: { sha256: 'a'.repeat(64) } } };
    const notices = [];
    const state = { tree: new Map([['revocations.json', {}]]), published: () => [record],
        currentStatus: () => ({ state: current }), raw: () => Buffer.from(JSON.stringify({ entries: restrictions })) };
    return { record, notices, state, ui: { say: (key, details) => notices.push({ key, details }) } };
}

test('已发布版本按当前状态提示，重复投稿不会覆盖或恢复历史版本', () => {
    for (const status of ['ACTIVE', 'YANKED', 'REVOKED']) {
        const f = context(status);
        const before = structuredClone(f.record);
        const original = versionAvailable(f.state, 'example', '2.3.4', 'a'.repeat(64));
        presentOriginal(f, original);
        assert.equal(f.notices[0].key, 'version' + status);
        assert.equal(f.notices[0].details.currentState, status);
        assert.equal(f.notices[0].details.pluginId, 'example');
        assert.deepEqual(f.record, before);
        assert.throws(() => versionAvailable(f.state, 'example', '2.3.4', 'b'.repeat(64)), /VERSION_DIGEST_CONFLICT/);
        assert.equal(versionAvailable(f.state, 'example', '2.3.5', 'b'.repeat(64)), null);
    }
});

test('状态投影合并作者历史与社区限制，失败不能降级为可用', () => {
    const f = context('YANKED', [{ packageSha256: 'a'.repeat(64), action: 'REVOKED' }]);
    assert.equal(versionState(f.state, f.record).currentState, 'REVOKED');
    f.state.currentStatus = () => ({ state: 'REVOKED' });
    f.state.raw = () => Buffer.from('{"entries":[]}');
    assert.equal(versionState(f.state, f.record).currentState, 'REVOKED');
    f.state.raw = () => Buffer.from('invalid');
    assert.throws(() => versionState(f.state, f.record));
});

test('待审核请求与已执行请求分开提示，旧管理请求显示最新状态', () => {
    const f = context('REVOKED');
    const pending = { url: 'https://example.invalid/pull/1', reused: true };
    presentOriginal(f, pending);
    assert.equal(f.notices.at(-1).key, 'requestPending');
    assert.equal(f.notices.at(-1).details, pending);
    const request = { payload: { pluginId: 'example', version: '2.3.4', packageSha256: 'a'.repeat(64), action: 'UNYANK' } };
    f.state.reference = () => Buffer.from(JSON.stringify(request));
    f.sdk = { document: () => ({ value: request }) };
    presentOriginal(f, pending, new Map([['version-status-requests/request.json', Buffer.from(JSON.stringify(request))]]));
    assert.equal(f.notices.at(-3).details.currentState, 'REVOKED');
    assert.equal(f.notices.at(-2).key, 'revokedRequestState');
    assert.equal(f.notices.at(-1).key, 'requestPending');
    presentOriginal(f, { value: { action: 'UNYANK', requestId: 'b'.repeat(64), requestRef: {} } });
    assert.equal(f.notices.at(-2).key, 'statusRequestApplied');
    assert.equal(f.notices.at(-1).key, 'versionREVOKED');
    f.state.published = () => [];
    assert.throws(() => presentOriginal(f, { value: { action: 'YANK', requestRef: {} } }), /PUBLISHED_VERSION_MISMATCH/);
});

test('旧状态请求恢复在验证前显示当前状态，不把旧 UNYANK 当成恢复成功', () => {
    for (const f of [context('REVOKED'), context('YANKED', [{ packageSha256: 'a'.repeat(64), action: 'REVOKED' }])]) {
        f.sdk = { document: () => ({ value: { payload: { pluginId: 'example', version: '2.3.4', packageSha256: 'a'.repeat(64), action: 'UNYANK' } } }) };
        const changes = new Map([['version-status-requests/old.json', Buffer.from('{}')]]);
        assert.throws(() => requestVersionNotice(f, changes, true), /INVALID_STATE_TRANSITION/);
        assert.equal(f.notices[0].details.currentState, 'REVOKED');
        assert.equal(f.notices[1].key, 'revokedRequestState');
    }
});

test('转移提醒仅在存在受限版本时显示，三类状态操作在最终确认说明生效后果', async () => {
    for (const state of ['ACTIVE', 'YANKED', 'REVOKED']) {
        const f = context(state);
        transferVersionNotice(f, 'example');
        assert.equal(f.notices.length, state === 'ACTIVE' ? 0 : 1);
        if (f.notices.length) assert.equal(f.notices[0].details.versions[0].currentState, state);
    }
    for (const action of ['YANK', 'UNYANK', 'REVOKE']) {
        const f = context(); let asked = 0;
        f.ui.ask = async (_key, _initial, validate) => { asked++; validate('example@2.3.4'); };
        const changes = new Map([['request.json', Buffer.from(JSON.stringify({ payload: {
            pluginId: 'example', version: '2.3.4', packageSha256: 'a'.repeat(64) } }))]]);
        await confirmRevocation(f.ui, { operation: action, requestPath: 'request.json' }, changes);
        assert(f.notices.some(notice => notice.key === 'effect' + action));
        assert.equal(asked, action === 'REVOKE' ? 1 : 0);
    }
});
