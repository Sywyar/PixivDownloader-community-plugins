import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pendingVersion } from '../submission-release.mjs';
import { policy } from '../github.mjs';

test('开放投稿按全局 ID 查重，组织成员可恢复自己的原 PR，同版本异包和重复 PR 拒绝', () => {
    const facts = { pluginId: 'example', version: '4.5.6', sha256: 'a'.repeat(64) };
    const source = { commit: 'b'.repeat(40) };
    let accountId = '303'; let accountType = 'Organization'; let digest = facts.sha256; let actor = '101'; let count = 1;
    const values = () => new Map([
        [`submissions/${accountId}/example/4.5.6.json`, { publisherId: 'publisher', pluginId: facts.pluginId,
            version: facts.version, source, package: { sha256: digest } }],
        [`publishers/${accountId}/publisher.json`, { githubAccount: { id: accountId, type: accountType } }],
    ]);
    const records = () => [...values()].map(([file, value]) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const sha = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
        return { file, bytes, sha };
    });
    const call = endpoint => {
        if (endpoint.includes('/pulls?')) return [Array.from({ length: count }, (_, i) => ({ id: i + 1, number: i + 1,
            user: { id: actor }, base: { repo: { id: policy.repositoryId } }, head: { sha: source.commit, repo: { full_name: 'actor/fork' } },
            html_url: `https://github.com/${policy.repository}/pull/${i + 1}` }))];
        if (endpoint.includes('/files?')) return [[{ filename: `submissions/${accountId}/example/4.5.6.json` }]];
        if (endpoint.includes('/git/trees/')) return { tree: records().map(r => ({ path: r.file, sha: r.sha, type: 'blob', mode: '100644', size: r.bytes.length })) };
        if (endpoint.includes('/git/blobs/')) {
            const r = records().find(r => endpoint.endsWith('/' + r.sha));
            return { sha: r.sha, size: r.bytes.length, encoding: 'base64', content: r.bytes.toString('base64') };
        }
        if (endpoint === 'organizations/303') return { id: 303, type: 'Organization', login: 'team' };
        if (endpoint === 'user/memberships/orgs/team') return { state: 'active', user: { id: 101 }, organization: { id: 303 } };
        throw new Error(endpoint);
    };
    const context = { call, snapshot: { actor: { id: '101' } }, state: { read: () => null },
        sdk: { document: (_kind, bytes) => ({ value: JSON.parse(bytes.toString('utf8')) }) } };
    assert.equal(pendingVersion(context, facts, source, null).reused, true);
    digest = 'c'.repeat(64); assert.throws(() => pendingVersion(context, facts, source, null), /VERSION_SUBMISSION_CONFLICT/u);
    digest = facts.sha256; count = 2; assert.throws(() => pendingVersion(context, facts, source, null), /VERSION_SUBMISSION_CONFLICT/u);
    count = 1; actor = '202'; assert.throws(() => pendingVersion(context, facts, source, null), /VERSION_SUBMISSION_CONFLICT/u);
    accountType = 'User'; accountId = '202'; assert.throws(() => pendingVersion(context, facts, source, null), /PLUGIN_ID_SUBMISSION_CONFLICT/u);
});
