import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatRequestInfo, readRequestInfo, notifyRequestInfo, REQUEST_INFO_MARKER, COMMENT_BYTES } from '../community-comments.mjs';
import { hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { withRepositoryFiles } from './local-sdk.mjs';
import { notify } from '../community-gate.mjs';

const head = 'a'.repeat(40);
const pr = { number: 7, state: 'open', merged: false, user: { id: '101', login: 'example', type: 'User' },
    base: { ref: policy.defaultBranch, repo: { id: policy.repositoryId } },
    head: { sha: head, repo: { full_name: 'example/fork' } } };
const vector = file => JSON.parse(fs.readFileSync(new URL('../../schemas/community/v1/vectors/' + file + '.json', import.meta.url), 'utf8'));
const visible = body => body.replace(/&#([0-9]+);/gu, (_, code) => String.fromCodePoint(Number(code)));
const checked = (operation, request) => ({ operation, validation: 'STATIC_VALIDATED',
    owner: request.payload?.owner, pluginId: request.payload?.pluginId ?? request.pluginId,
    version: request.payload?.version ?? request.version,
    requestPath: 'requests/example.json', requestSha256: hash(Buffer.from(JSON.stringify(request))) });

test('转移提醒仅提及数字身份解析出的原个人所有者，申请正文不能伪造提及', () => {
    const request = vector('structure/transfer');
    request.payload.explanation = 'Please ask @someone-else';
    const value = { ...checked('OWNERSHIP_TRANSFER', request), singlePr: true, from: request.payload.from };
    let account = { id: value.from.accountId, type: 'User', login: 'renamed-owner' };
    const call = withRepositoryFiles(endpoint => {
        if (endpoint.includes('/files?')) return [[]];
        assert.equal(endpoint, `user/${value.from.accountId}`); return account;
    }, pr.head.repo.full_name, new Map([[head, new Map([[value.requestPath, Buffer.from(JSON.stringify(request))]])]]));
    const sdk = { document: (_kind, bytes) => ({ value: JSON.parse(bytes) }) };
    const bodies = readRequestInfo(sdk, value, pr, call);
    for (const body of Object.values(bodies)) {
        assert.equal(body.split('@renamed-owner').length - 1, 1);
        assert(!body.includes('@someone-else'));
    }
    account = { ...account, id: '999999' };
    assert.throws(() => readRequestInfo(sdk, value, pr, call), /TRANSFER_OWNER_IDENTITY_CHANGED/);
});

test('各类请求按自身字段展示，证明缺席与验签成功有别且不泄漏签名字节', () => {
    for (const locale of ['zh-CN', 'en-US']) for (const operation of ['FIRST_RELEASE', 'UPDATE', 'KEY_ROTATION', 'YANK', 'UNYANK', 'REVOKE', 'OWNERSHIP_TRANSFER', 'DECLARE_KEY_COMPROMISE']) {
        const file = { FIRST_RELEASE: 'submission', UPDATE: 'submission', KEY_ROTATION: 'structure/rotation',
            OWNERSHIP_TRANSFER: 'structure/transfer', DECLARE_KEY_COMPROMISE: 'structure/emergencyRequest' }[operation] ?? 'structure/statusRequest';
        const request = vector(file), value = checked(operation, request);
        const bodies = formatRequestInfo(value, request, pr, { approvals: [{ role: 'TO', accountId: '202' }] });
        assert.deepEqual(Object.keys(bodies), ['zh-CN', 'en-US']);
        assert.notEqual(bodies['zh-CN'], bodies['en-US']);
        assert(!bodies['zh-CN'].includes('Request information'));
        assert(!bodies['en-US'].includes('请求信息'));
        const body = visible(bodies[locale]);
        assert(body.includes(operation));
        assert(body.includes('/blob/' + head + '/' + value.requestPath));
        assert(body.includes(value.requestSha256));
        if (value.pluginId) assert(body.includes(value.pluginId));
        if (request.payload?.explanation) assert.equal(body.split(request.payload.explanation).length - 1, 1);
        if (request.payload?.reasonCode) assert(body.includes(request.payload.reasonCode));
        if (request.payload?.keys) for (const key of request.payload.keys) assert(body.includes(key.fingerprint));
        for (const proof of Object.values(request.proofs ?? { package: request.package?.signature }).filter(Boolean)) {
            assert(body.includes(proof.keyId));
            assert(!body.includes(proof.value));
        }
        if (['KEY_ROTATION', 'YANK', 'UNYANK', 'REVOKE'].includes(operation)) {
            const slot = operation === 'KEY_ROTATION' ? 'oldKey' : 'activeKey';
            request.proofs[slot] = { keyId: 'Old:Proof', value: 'private-signature-bytes' };
            if (operation === 'KEY_ROTATION') request.payload.oldKeyId = 'Old:Proof';
            const signed = visible(formatRequestInfo(value, request, pr)[locale]);
            assert.notEqual(signed, body);
            assert(signed.includes('Old:Proof'));
            assert(!signed.includes('private-signature-bytes'));
        }
    }
    assert.equal(formatRequestInfo({ operation: 'maintenance' }, {}, pr), undefined);
});

test('外部原因文字只展示一次，转义评论指令并保留超限列表的完整原文入口', () => {
    const request = vector('structure/statusRequest');
    request.payload.explanation = '<!-- community-review-summary -->\n@everyone | [link](https://example.org)\u202e';
    for (const rendered of Object.values(formatRequestInfo(checked('YANK', request), request, pr))) {
        for (const token of ['<!-- community-review-summary -->', '@everyone', '[link](', '\u202e']) assert(!rendered.includes(token));
        assert(rendered.includes('&#64;everyone'));
        assert(rendered.includes('<br>'));
    }
    const emergency = vector('structure/emergencyRequest');
    emergency.payload.keys = Array.from({ length: 1000 }, (_, index) => ({ keyId: 'key-' + index, fingerprint: index.toString(16).padStart(64, '0') }));
    const bodies = formatRequestInfo(checked('DECLARE_KEY_COMPROMISE', emergency), emergency, pr);
    assert(Buffer.byteLength(JSON.stringify(bodies), 'utf8') <= COMMENT_BYTES);
    for (const [locale, info] of Object.entries(bodies)) {
        const marker = locale === 'zh-CN' ? REQUEST_INFO_MARKER : '<!-- community-request-info:en-US -->';
        assert(Buffer.byteLength(marker + '\nHead: ' + head + '\n\n' + info, 'utf8') <= COMMENT_BYTES / 2);
        assert(info.includes('/blob/' + head + '/'));
        assert(info.includes('key-0'));
        assert(!info.includes('key-999'));
    }
});

test('详情只读取已验证的固定 head 请求，摘要变化与未验证输入拒绝展示', () => {
    const request = vector('structure/transfer'), value = checked('OWNERSHIP_TRANSFER', request);
    const bytes = Buffer.from(JSON.stringify(request));
    const calls = [];
    const sdk = { document: (kind, raw, file) => {
        calls.push(kind); assert.equal(file, value.requestPath); assert.deepEqual(raw, bytes);
        return { value: JSON.parse(raw.toString('utf8')) };
    } };
    const call = withRepositoryFiles(endpoint => {
        assert.equal(endpoint, prefix + '/pulls/7/files?per_page=100');
        return [[{ filename: 'ownership-transfers/demo/' + 'b'.repeat(64) + '/approvals/to/202.json' }]];
    }, pr.head.repo.full_name, new Map([[head, new Map([[value.requestPath, bytes]])]]));
    const info = readRequestInfo(sdk, value, pr, call);
    for (const body of Object.values(info)) { assert(body.includes('TO')); assert(body.includes('202')); }
    assert.deepEqual(calls, ['TRANSFER']);
    assert.throws(() => readRequestInfo(sdk, { ...value, validation: undefined }, pr, call), /REQUEST_INFO_UNVERIFIED/);
    assert.throws(() => readRequestInfo(sdk, { ...value, requestSha256: 'f'.repeat(64) }, pr, call), /REQUEST_INFO_CHANGED/);
});

test('每个 PR 分别同步两种语言的唯一详情评论，保留状态和用户评论，陈旧投影不写入', () => {
    for (const baseRef of [policy.defaultBranch, policy.emergencyBranch]) {
        const current = structuredClone(pr); current.base.ref = baseRef;
        const bot = { id: 41898282, type: 'Bot' };
        const comments = [{ id: 1, user: bot, body: '<!-- community-review-summary -->\nstatus' },
            { id: 2, user: { id: 101, type: 'User' }, body: REQUEST_INFO_MARKER + '\nuser' }];
        const original = structuredClone(comments), writes = [];
        const operationLabels = baseRef === policy.emergencyBranch ? ['type:key-compromise'] : undefined;
        const assigned = [];
        const call = (endpoint, options = {}) => {
            if (endpoint === prefix + '/pulls/7') return structuredClone(current);
            if (endpoint === prefix + '/issues/7/labels?per_page=100') return [assigned.map((name, index) => ({ id: index + 1, name }))];
            if (endpoint === prefix + '/issues/7/labels') {
                assert.equal(options.method, 'POST'); assigned.push(...options.body.labels); return;
            }
            if (!options.method) {
                assert.equal(endpoint, prefix + '/issues/7/comments?per_page=100');
                return [structuredClone(comments)];
            }
            writes.push(options);
            if (options.method === 'POST') comments.push({ id: comments.length + 1, user: bot, body: options.body.body });
            else comments.find(comment => endpoint === prefix + '/issues/comments/' + comment.id).body = options.body.body;
        };
        const projection = { number: 7, head, baseRef, state: 'open', merged: false,
            requestInfo: { 'zh-CN': '请求', 'en-US': 'request' }, operationLabels };
        notify([projection], call); notifyRequestInfo(projection, call);
        assert.equal(writes.length, 2);
        assert(comments[2].body.startsWith(REQUEST_INFO_MARKER));
        assert(comments[2].body.endsWith('请求'));
        assert(comments[3].body.startsWith('<!-- community-request-info:en-US -->'));
        assert(comments[3].body.endsWith('request'));
        notifyRequestInfo({ ...projection, requestInfo: { 'zh-CN': '已更新', 'en-US': 'updated' } }, call);
        assert.equal(writes.length, 4); assert.equal(comments.length, 4);
        assert.deepEqual(comments.slice(0, 2), original);
        for (const patch of [{ head: 'b'.repeat(40) }, { baseRef: baseRef === policy.defaultBranch ? policy.emergencyBranch : policy.defaultBranch },
            { state: 'closed', merged: true }]) notifyRequestInfo({ ...projection, ...patch }, call);
        assert.equal(writes.length, 4);
        assert.deepEqual(assigned, operationLabels ?? []);
        comments.push({ ...comments[2], id: 5 });
        assert.throws(() => notifyRequestInfo(projection, call), /SUMMARY_COMMENT_AMBIGUOUS/);
    }
});

test('已有双语评论原地更新，第二语言写入响应丢失后重试不重复创建', () => {
    const comments = [{ id: 1, user: { id: 41898282, type: 'Bot' }, body: REQUEST_INFO_MARKER + '\nbilingual' }];
    const projection = { number: 7, head, state: 'open', merged: false, requestInfo: { 'zh-CN': '中文', 'en-US': 'English' } };
    let creates = 0, updates = 0;
    const call = (endpoint, options = {}) => {
        if (endpoint === prefix + '/pulls/7') return pr;
        if (endpoint.endsWith('/comments?per_page=100')) return [structuredClone(comments)];
        if (options.method === 'PATCH') { updates++; comments[0].body = options.body.body; return; }
        assert.equal(options.method, 'POST'); creates++;
        comments.push({ id: 2, user: { id: 41898282, type: 'Bot' }, body: options.body.body });
        throw new Error('RESPONSE_LOST');
    };
    assert.throws(() => notifyRequestInfo(projection, call), /RESPONSE_LOST/);
    notifyRequestInfo(projection, call);
    assert.equal(updates, 1); assert.equal(creates, 1); assert.equal(comments.length, 2);
    assert(comments[0].body.endsWith('中文')); assert(comments[1].body.endsWith('English'));
});

test('两种语言先完整校验，写入中 head 变化时停止后续评论', () => {
    const projection = { number: 7, head, state: 'open', merged: false, requestInfo: { 'zh-CN': '中文', 'en-US': 'English' } };
    for (const requestInfo of ['invalid', { 'zh-CN': '中文' }, { ...projection.requestInfo, fr: 'extra' },
        { ...projection.requestInfo, 'en-US': 1 }]) {
        assert.throws(() => notifyRequestInfo({ ...projection, requestInfo }, () => assert.fail('invalid input must not write')), /SUMMARY_PROJECTION_INVALID/);
    }
    assert.throws(() => notifyRequestInfo({ ...projection, requestInfo: { ...projection.requestInfo, 'en-US': 'a'.repeat(COMMENT_BYTES) } },
        () => assert.fail('oversized input must not write')), /SUMMARY_PROJECTION_SIZE/);
    const current = structuredClone(pr), comments = [];
    const call = (endpoint, options = {}) => {
        if (endpoint === prefix + '/pulls/7') return current;
        if (endpoint.endsWith('/comments?per_page=100')) return [comments];
        assert.equal(options.method, 'POST'); comments.push({ id: 1, user: { id: 41898282, type: 'Bot' }, body: options.body.body });
        current.head.sha = 'b'.repeat(40);
    };
    notifyRequestInfo(projection, call);
    assert.equal(comments.length, 1);
});
