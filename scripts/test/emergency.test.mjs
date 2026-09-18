import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prepareSubmission } from './local-sdk.mjs';
import { hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { checkEmergency, emergencyAuthority } from '../emergency-request.mjs';
import { emergencyState, keyFingerprint } from '../emergency-state.mjs';
import { applyEmergency } from '../community-emergency.mjs';
import { freezeVersions, restoreVersions } from '../community-gate.mjs';
import { prepareEmergency, validateEmergencySubmission, appliedEmergency, keyLabel } from '../submission-emergency.mjs';
import { localizedText, locales } from '../submission-ui.mjs';
import { stateReader } from '../submission-github.mjs';
import fs from 'node:fs';
import path from 'node:path';

let sdk;
before(() => { sdk = prepareSubmission(); });
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');

function fixture(sameRepository = false) {
    const accountId = sameRepository ? policy.repositoryOwnerId : '101';
    const sourceName = sameRepository ? policy.repository : 'example/fork';
    const keys = ['ACTIVE', 'RETIRED'].map(state => ({ keyId: crypto.randomUUID(), algorithm: 'Ed25519', state,
        publicKeySpkiBase64: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));
    const publisher = { schemaVersion: 1, publisherId: 'example', displayName: 'Example',
        githubAccount: { id: accountId, type: 'User', loginAtRegistration: 'example' }, signingKeys: keys };
    const owner = { accountId, accountType: 'User', publisherId: 'example' };
    const request = { schemaVersion: 1, requestId: '0'.repeat(64), payload: { operation: 'DECLARE_KEY_COMPROMISE', owner,
        publisherRecordSha256: hash(bytes(publisher)), keys: keys.map(key => ({ keyId: key.keyId, fingerprint: keyFingerprint(key) })) } };
    request.requestId = sdk.invoke({ command: 'canonical', kind: 'EMERGENCY_REQUEST', file: sdk.save(request) }).requestId;
    const requestPath = `requests/${accountId}/example/${request.requestId}.json`;
    const current = 'a'.repeat(40), base = 'b'.repeat(40), head = 'c'.repeat(40), generated = 'd'.repeat(40);
    const marker = new Map([['state.json', bytes({ schemaVersion: 1, kind: 'community-emergency-state', repositoryId: policy.repositoryId })]]);
    const trees = new Map(), blobs = new Map(), records = new Map();
    const setTree = (sha, values) => {
        records.set(sha, new Map(values));
        trees.set(sha, [...values].map(([path, raw]) => {
            const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest('hex');
            blobs.set(sha, { sha, size: raw.length, encoding: 'base64', content: raw.toString('base64') });
            return { path, sha, mode: '100644', type: 'blob', size: raw.length };
        }));
    };
    setTree(current, new Map([[`publishers/${accountId}/example.json`, bytes(publisher)]]));
    setTree(base, marker); setTree(head, new Map([...marker, [requestPath, bytes(request)]]));
    const pr = { number: 5, state: 'open', merged: false, draft: false, maintainer_can_modify: true,
        user: { id: accountId, type: 'User', login: 'example' },
        base: { ref: policy.emergencyBranch, sha: base, repo: { id: policy.repositoryId } },
        head: { ref: 'community/emergency/test', sha: head, repo: { id: sameRepository ? policy.repositoryId : '400', full_name: sourceName } } };
    let revision = base, protectedBranch = true;
    const call = (endpoint, options = {}) => {
        assert(!options.method || options.method === 'GET');
        if (endpoint === `${prefix}/pulls/5`) return structuredClone(pr);
        if (sameRepository && endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository, private: false, archived: false };
        if (endpoint === 'repos/example/fork') return { id: '400', full_name: 'example/fork', fork: true, parent: { id: policy.repositoryId } };
        if (endpoint === `${prefix}/branches/${policy.defaultBranch}`) return { commit: { sha: current } };
        if (endpoint === `${prefix}/branches/${policy.emergencyBranch}`) return { name: policy.emergencyBranch, protected: protectedBranch, commit: { sha: revision } };
        const tree = /\/git\/trees\/([a-f0-9]{40})\?recursive=1$/u.exec(endpoint);
        if (tree) return { tree: structuredClone(trees.get(tree[1])) };
        const blob = /\/git\/blobs\/([a-f0-9]{40})$/u.exec(endpoint);
        if (blob) return structuredClone(blobs.get(blob[1]));
        if (endpoint === `repos/${sourceName}/git/commits/${generated}`) return { parents: [{ sha: head }] };
        assert.fail(endpoint);
    };
    return { keys, request, requestPath, publisher, pr, current, base, head, generated, setTree, records, call,
        advance(value) { revision = value; }, unprotect() { protectedBranch = false; } };
}

for (const sameRepository of [false, true]) test(`紧急请求${sameRepository ? '所有者同仓' : '普通 fork'}追加并合并；响应丢失不重复，通知失败可恢复`, async () => {
    const f = fixture(sameRepository), createdBlobs = new Map(), checks = new Map();
    const source = `repos/${f.pr.head.repo.full_name}`;
    const context = { current: f.current, run: { id: '71', run_attempt: 1 } };
    const blockedRequest = { number: 19, head: { sha: '7'.repeat(40), repo: { full_name: 'example/fork' } }, changed_files: 1 };
    let patched = 0, merged = 0, refreshes = 0, failRefresh = true, generatedTree;
    const call = (endpoint, options = {}) => {
        const body = options.body;
        if (endpoint === 'user') return { id: policy.repositoryOwnerId, type: 'User' };
        if (endpoint.startsWith(`${prefix}/pulls?state=open&base=`)) return [[blockedRequest]];
        if (endpoint.startsWith(`${prefix}/pulls/19/files?`)) return [[{ filename: 'ownership-transfers/demo/' + '1'.repeat(64) + '/approvals/to/202.json' }]];
        if (endpoint.includes('/git/trees/' + '7'.repeat(40))) throw new Error('HEAD_UNAVAILABLE');
        if (endpoint.startsWith(`${prefix}/pulls/5/files?`)) return [[{ filename: f.requestPath, status: 'added' }]];
        if (endpoint === source + '/git/blobs' && options.method === 'POST') {
            const bytes = Buffer.from(body.content, 'base64');
            const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
            createdBlobs.set(sha, bytes); return { sha };
        }
        if (endpoint === `${source}/git/commits/${f.head}`) return { tree: { sha: f.head } };
        if (endpoint === source + '/git/trees' && options.method === 'POST') {
            assert.equal(body.base_tree, f.head);
            generatedTree = new Map([...f.records.get(f.head), ...body.tree.map(file => [file.path, createdBlobs.get(file.sha)])]);
            return { sha: f.generated };
        }
        if (endpoint === source + '/git/commits' && options.method === 'POST') {
            assert.deepEqual(body.parents, [f.head]); f.setTree(f.generated, generatedTree); return { sha: f.generated };
        }
        if (endpoint.startsWith(source + '/git/refs/heads/') && options.method === 'PATCH') {
            patched++; assert.equal(body.force, false); f.pr.head.sha = body.sha; throw new Error('RESPONSE_LOST');
        }
        if (endpoint.startsWith(source + '/git/ref/heads/')) return { object: { sha: f.pr.head.sha } };
        if (endpoint === `${prefix}/check-runs` && options.method === 'POST') {
            const result = { ...body, id: String(checks.size + 1), app: policy.gateApp };
            checks.set(result.id, result); return result;
        }
        if (endpoint.startsWith(`${prefix}/check-runs/`)) return checks.get(endpoint.split('/').at(-1));
        if (endpoint === `${prefix}/pulls/5/merge`) {
            assert.equal(body.sha, f.generated); assert.equal(body.merge_method, 'merge');
            assert([...checks.values()].some(check => check.head_sha === blockedRequest.head.sha && check.conclusion === 'failure'));
            merged++; f.pr.merged = true; f.pr.state = 'closed'; f.pr.merge_commit_sha = 'f'.repeat(40);
            f.setTree(f.pr.merge_commit_sha, generatedTree); f.advance(f.pr.merge_commit_sha);
            throw new Error('RESPONSE_LOST');
        }
        if (endpoint === `${prefix}/git/commits/${'f'.repeat(40)}`) return { parents: [{ sha: f.base }, { sha: f.generated }] };
        if (endpoint.endsWith('/actions/workflows/community-gate.yml/dispatches')) {
            refreshes++; if (failRefresh) throw new Error('NETWORK'); return null;
        }
        return f.call(endpoint, options);
    };
    const previous = process.env.COMMUNITY_REVIEW_BRANCH_TOKEN;
    process.env.COMMUNITY_REVIEW_BRANCH_TOKEN = 'test-only';
    try {
        const result = await applyEmergency(context, sdk, 5, f.head, { call, token: 'test-only', wait: async () => {} });
        assert.equal(result.merged, true); assert.deepEqual(result.pendingRefresh, [19]);
        assert.equal(result.projection.baseRef, policy.emergencyBranch);
        assert.equal(result.projection.head, f.generated);
        assert.equal(result.projection.merged, true);
        for (const key of f.keys) assert(result.projection.requestInfo.includes(keyFingerprint(key)));
        assert.throws(() => emergencyState(sdk, call).requireKey(f.keys[0]), /KEY_DECLARED_COMPROMISED/);
        failRefresh = false;
        const resumed = await applyEmergency(context, sdk, 5, f.head, { call, token: 'test-only' });
        assert.deepEqual(resumed.projection, result.projection);
        assert.deepEqual(resumed.pendingRefresh, []); assert.equal(patched, 1); assert.equal(merged, 1); assert.equal(refreshes, 2);
    } finally {
        if (previous === undefined) delete process.env.COMMUNITY_REVIEW_BRANCH_TOKEN;
        else process.env.COMMUNITY_REVIEW_BRANCH_TOKEN = previous;
    }
});

test('准入跨 job 数据仅接受同一次可信执行，证据原字节校验并拒绝路径逃逸', () => {
    const context = { current: 'a'.repeat(40), run: { id: '71', run_attempt: 2 } };
    const raw = Buffer.from('evidence'), file = 'evidence/' + hash(raw) + '.json';
    fs.mkdirSync(path.join(sdk.workspace, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sdk.workspace, file), raw);
    const ref = { path: file, size: raw.length, sha256: hash(raw) };
    const rows = [{ number: 5, version: { candidate: { evidence: [ref] } } },
        { number: 6, version: { statusAuthorization: { binding: 'a'.repeat(64), audit: ref } } }];
    const frozen = freezeVersions(context, rows, sdk);
    assert.deepEqual(restoreVersions(frozen, context, sdk), rows);
    assert.throws(() => restoreVersions(frozen, { ...context, current: 'b'.repeat(40) }, sdk), /GATE_TRANSFER_CHANGED/);
    assert.throws(() => restoreVersions(frozen, { ...context, run: { id: '72', run_attempt: 2 } }, sdk), /GATE_TRANSFER_CHANGED/);
    const changed = JSON.parse(frozen); changed.evidence[0].bytes = Buffer.from('changed!').toString('base64');
    assert.throws(() => restoreVersions(bytes(changed), context, sdk), /GATE_EVIDENCE_CHANGED/);
    changed.evidence[0] = { path: '../escape', size: raw.length, sha256: hash(raw), bytes: raw.toString('base64') };
    assert.throws(() => restoreVersions(bytes(changed), context, sdk), /PATH_MISMATCH/);
});

test('本人批量声明经真实 SDK 生成固定封禁记录，阻断改 keyId 的新操作且不修改发布者历史', () => {
    const f = fixture(), before = bytes(f.publisher);
    const pending = checkEmergency(5, f.head, sdk, f.current, f.call);
    assert.equal(pending.ready, false); assert.equal(pending.writes.size, 2);
    f.setTree(f.generated, new Map([...f.records.get(f.head), ...pending.writes])); f.pr.head.sha = f.generated;
    const ready = checkEmergency(5, f.generated, sdk, f.current, f.call);
    assert.equal(ready.ready, true);
    f.advance(f.generated);
    const state = emergencyState(sdk, f.call);
    assert.throws(() => state.requireKey({ ...f.keys[0], keyId: 'renamed' }), /KEY_DECLARED_COMPROMISED/u);
    assert.throws(() => state.requireKey(f.keys[1]), /KEY_DECLARED_COMPROMISED/u);
    assert.deepEqual(bytes(f.publisher), before);
    f.advance(f.base); assert.throws(state.unchanged, /EMERGENCY_STATE_CHANGED/u);
    f.unprotect(); assert.throws(() => emergencyState(sdk, f.call), /EMERGENCY_BRANCH_UNPROTECTED/u);
});

test('紧急向导可多选当前与历史密钥，无需密码；生效后原字节恢复且不重复写入', async () => {
    const f = fixture(), labels = [], notices = [], contexts = [];
    const context = { sdk, state: stateReader(sdk, f.current, f.call), call: f.call,
        snapshot: { actor: { id: '101', type: 'User' } },
        ui: { text: key => key, say: (key, value) => { notices.push(key); if (key === 'keyContext') contexts.push(value); },
            select: async (_key, values) => values[0],
            multiselect: async (_key, values) => { labels.push(...values); return values; },
            confirm: async () => true } };
    const prepared = await prepareEmergency(context);
    assert.equal(labels.length, 2);
    for (const key of f.keys) assert(labels.some(label => label.includes(key.keyId) && label.includes(key.state) && label.includes(keyFingerprint(key))));
    const checked = validateEmergencySubmission({ ...context, changes: prepared.changes, user: context.snapshot.actor });
    assert.equal(checked.keys.length, 2); assert(notices.includes('emergencyHelp'));
    const [file, raw] = [...prepared.changes][0];
    assert.equal(file, f.requestPath);
    f.setTree(f.head, new Map([...f.records.get(f.base), [file, raw]]));
    const pending = checkEmergency(5, f.head, sdk, f.current, f.call);
    f.setTree(f.generated, new Map([...f.records.get(f.head), ...pending.writes]));
    f.advance(f.generated);
    assert.equal(appliedEmergency(sdk, prepared.changes, f.call).applied, true);
    await assert.rejects(() => prepareEmergency(context), /WIZARD_MENU/);
    assert(notices.includes('operationUnavailable'));
    assert.equal(contexts.at(-1).length, 2);
    for (const key of f.keys) assert(contexts.at(-1).some(label =>
        label.includes(key.keyId) && label.includes('option.DECLARED_COMPROMISED')));
    for (const locale of locales) {
        context.ui.text = key => localizedText(locale, key);
        for (const key of f.keys) {
            const label = keyLabel(context, f.request.payload.owner, key);
            assert(label.includes(localizedText(locale, 'option.DECLARED_COMPROMISED')));
            assert(!label.includes(localizedText(locale, 'option.' + key.state)));
        }
    }
    assert.equal(f.publisher.signingKeys[0].state, 'ACTIVE');
});

test('拒绝冒用 GitHub 作者、陈旧发布者、夹带文件和篡改生成记录', () => {
    const f = fixture();
    f.pr.user.id = '202';
    assert.throws(() => checkEmergency(5, f.head, sdk, f.current, f.call), /BINDING_MISMATCH/u);
    f.pr.user.id = '101';
    f.setTree(f.current, new Map([['publishers/101/example.json', bytes({ ...f.publisher, displayName: 'Changed' })]]));
    assert.throws(() => checkEmergency(5, f.head, sdk, f.current, f.call), /BASELINE_CHANGED/u);
    f.setTree(f.current, new Map([['publishers/101/example.json', bytes(f.publisher)]]));
    const pending = checkEmergency(5, f.head, sdk, f.current, f.call);
    f.setTree(f.head, new Map([...f.records.get(f.head), ['scripts/execute.mjs', Buffer.from('not allowed')]]));
    assert.throws(() => checkEmergency(5, f.head, sdk, f.current, f.call), /EMERGENCY_FILES_INVALID/u);
    f.records.get(f.head).delete('scripts/execute.mjs'); f.setTree(f.head, f.records.get(f.head));
    const [file, raw] = [...pending.writes][0], forged = JSON.parse(raw);
    forged.pr.authorAccountId = '202';
    f.setTree(f.generated, new Map([...f.records.get(f.head), ...pending.writes, [file, bytes(forged)]])); f.pr.head.sha = f.generated;
    assert.throws(() => checkEmergency(5, f.generated, sdk, f.current, f.call), /EMERGENCY_RECORD_MISMATCH/u);
});

test('组织声明必须由平台证实管理员角色，普通成员和不可见权限不能放行', () => {
    const f = fixture(), owner = { accountId: '900', accountType: 'Organization', publisherId: 'org' };
    let role = 'member';
    const call = endpoint => endpoint.startsWith('organizations/')
        ? { id: '900', type: 'Organization', login: 'organization' }
        : { state: 'active', role, user: { id: '101' }, organization: { id: '900' } };
    assert.throws(() => emergencyAuthority(f.pr, owner, call), /EMERGENCY_ORG_ADMIN_REQUIRED/u);
    role = 'admin'; assert.equal(emergencyAuthority(f.pr, owner, call).representations.length, 1);
    assert.throws(() => emergencyAuthority(f.pr, owner, () => { throw Error('403'); }), /EMERGENCY_ORG_ADMIN_UNVERIFIED/u);
});
