import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWizard } from '../submit.mjs';
import { prepareSubmission, withEmergencyState, withRepositoryFiles } from './local-sdk.mjs';
import { root, hash } from '../sdk.mjs';
import { policy, prefix } from '../github.mjs';
import { openManagement } from '../submission-state.mjs';
import { saveSession, savePrepared, sessionLocator, preparedChanges } from '../submission-session.mjs';
import { localizedText } from '../submission-ui.mjs';

for (const change of ['unrelated', 'binding', 'account', 'continuous', 'diverged']) {
    test(`真实向导在 ${change} 主线变化后恢复原请求或保留进度拒绝`, async t => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-base-'));
        const priorExit = process.exitCode;
        t.after(() => { process.exitCode = priorExit; fs.rmSync(home, { recursive: true }); });
        const sdk = prepareSubmission();
        const vector = name => JSON.parse(fs.readFileSync(path.join(root, `schemas/community/v1/vectors/structure/${name}.json`), 'utf8'));
        const encode = value => Buffer.from(JSON.stringify(value));
        const binding = vector('binding'), published = vector('published');
        const files = new Map([
            ['plugin-bindings/demo.json', encode(binding)],
            ['publishers/101/example.json', encode(vector('publisher'))],
            ['published/demo/2.3.4.json', encode(published)],
            ['revocations/restrictions.json', encode([])],
        ]);
        const request = vector('statusRequest');
        request.payload.pluginBindingSha256 = hash(files.get('plugin-bindings/demo.json'));
        request.requestId = sdk.invoke({ command: 'canonical', kind: 'STATUS_REQUEST', file: sdk.save(request) }).requestId;
        const changes = new Map([[`version-status-requests/101/demo/2.3.4/${request.requestId}.json`, encode(request)]]);
        const actor = { id: '101', type: 'User', login: 'author' };
        const base = 'a'.repeat(40), snapshot = { repositoryId: policy.repositoryId, base, actor };
        const store = openManagement(actor.id, { home });
        saveSession({ store, ui: { locale: 'en-US' } }, { operation: 'YANK', sourceCommit: null });
        savePrepared({ store, snapshot, ui: { locale: 'en-US' } }, { changes, title: 'chore(plugin): YANK demo 2.3.4' });
        sessionLocator(home, home).bind(store, actor.id); store.close();
        let current = base, currentActor = actor, confirmations = 0;
        const notices = [], revisions = new Map([[base, files]]);
        const forkName = `author/${policy.repository.split('/')[1]}`;
        const call = withEmergencyState(withRepositoryFiles((endpoint, options = {}) => {
            assert.equal(options.method ?? 'GET', 'GET', '取消或冲突之前不能写远端');
            if (endpoint === 'user') return currentActor;
            if (endpoint === prefix) return { id: policy.repositoryId, full_name: policy.repository,
                owner: { id: policy.repositoryOwnerId }, default_branch: policy.defaultBranch };
            if (endpoint === `${prefix}/git/ref/heads/${policy.defaultBranch}`) return { object: { sha: current } };
            if (endpoint === `repos/${forkName}`) return { full_name: forkName, id: '202', owner: actor, fork: true, parent: { id: policy.repositoryId } };
            if (endpoint.includes('/pulls?')) return [[]];
            if (endpoint === `${prefix}/compare/${base}...${current}`) return {
                status: change === 'diverged' ? 'diverged' : 'ahead', merge_base_commit: { sha: base },
            };
            assert.fail(endpoint);
        }, policy.repository, revisions));
        const result = await runWizard(home, { call, stateHome: home, prepare: () => sdk, ui: {
            locale: 'en-US', resume: true, text: key => localizedText('en-US', key), close() {},
            task: (_key, work) => work(), say: (key, details) => notices.push({ key, details }),
            select: () => assert.fail('已准备的请求不应重新填写'),
            password: () => assert.fail('保存的原请求不应重新签名'),
            confirm: (key, preview) => {
                assert.equal(key, 'preview'); confirmations++;
                assert.equal(preview.base, base);
                assert.equal(preview.files[0].sha256, hash(changes.values().next().value));
                if (change !== 'continuous' && confirmations > 1) {
                    assert.equal(preview.validatedBase, current); return false;
                }
                current = String(confirmations).repeat(40);
                const next = new Map(files);
                next.set('unrelated.json', encode({ revision: confirmations }));
                if (change === 'binding') next.set('plugin-bindings/demo.json', encode({ ...binding, owner: { ...binding.owner, accountId: '303' } }));
                if (change === 'account') currentActor = { ...actor, id: '303' };
                revisions.set(current, next);
                return true;
            },
        } });
        const expected = { unrelated: { cancelled: true }, binding: { failed: 'BINDING_CHANGED' },
            account: { failed: 'COMMUNITY_IDENTITY_CHANGED' }, continuous: { failed: 'COMMUNITY_BASE_UNSTABLE' },
            diverged: { failed: 'SUBMISSION_BASE_DIVERGED' } }[change];
        assert.deepEqual(result, expected, JSON.stringify(notices));
        assert.equal(confirmations, change === 'continuous' ? 4 : change === 'unrelated' ? 2 : 1);
        const resumed = openManagement(actor.id, { home });
        try {
            assert.deepEqual(preparedChanges(resumed).changes, changes);
            assert.equal(resumed.record.session.prepared.snapshot.base, base);
            assert.equal(sessionLocator(home, home).read().actorId, actor.id);
        } finally { resumed.close(); }
        assert.equal(notices.filter(notice => notice.key === 'sessionBaseUpdated').length, change === 'account' ? 0 : change === 'continuous' ? 3 : 1);
    });
}
