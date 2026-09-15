import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openProject, projectIdentity, CACHE_FILES, STATE_BYTES } from '../submission-state.mjs';
import { hash } from '../sdk.mjs';

test('项目和账号分别恢复填写记录，互斥锁与摘要校验阻止串用及损坏缓存', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-state-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const identity = projectIdentity('101', '.', 'example');
    const state = openProject(identity, '201', { home });
    state.remember('name', 'Example');
    state.remember('password', 'never persist');
    assert.throws(() => openProject(identity, '201', { home }), /PROJECT_STATE_LOCKED/u);
    const bytes = Buffer.from('candidate'); const digest = hash(bytes);
    const file = path.join(home, 'package.jar'); fs.writeFileSync(file, bytes);
    state.retain(file, digest, bytes.length);
    assert.equal(fs.readFileSync(state.cached(digest, bytes.length)).toString(), 'candidate');
    state.close();
    const again = openProject(identity, '201', { home });
    assert.equal(again.answer('name'), 'Example');
    assert.equal(again.answer('password'), undefined);
    again.complete({ url: 'https://github.com/example/community/pull/1' });
    assert.equal(again.answer('name'), 'Example');
    assert(!fs.readFileSync(path.join(again.folder, 'profile.json'), 'utf8').includes('never persist'));
    fs.writeFileSync(again.cached(digest, bytes.length), 'corrupted');
    assert.throws(() => again.cached(digest, bytes.length), /CACHE_DIGEST_CHANGED/u);
    again.close();
    for (const [project, actor] of [[identity, '202'], [projectIdentity('102', '.', 'example'), '201'],
        [projectIdentity('101', 'nested', 'example'), '201'], [projectIdentity('101', '.', 'different'), '201']]) {
        const other = openProject(project, actor, { home });
        assert.equal(other.answer('name'), undefined); other.close();
    }
});

test('缓存满额淘汰最旧包，档案超限保留原文件并释放项目锁', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-budget-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const identity = projectIdentity('101', '.', 'example');
    const state = openProject(identity, '201', { home });
    const file = path.join(home, 'package.jar');
    const digests = [];
    for (let i = 0; i < CACHE_FILES + 1; i++) {
        const bytes = Buffer.from(String(i));
        const digest = hash(bytes);
        fs.writeFileSync(file, bytes);
        const retained = state.retain(file, digest, bytes.length);
        fs.utimesSync(retained, i + 1, i + 1);
        digests.push({ digest, size: bytes.length });
    }
    assert.equal(state.cached(digests[0].digest, digests[0].size), null);
    assert.equal(fs.readdirSync(path.join(state.folder, 'cache')).length, CACHE_FILES);
    for (const { digest, size } of digests.slice(1)) assert(state.cached(digest, size));
    const profile = path.join(state.folder, 'profile.json');
    state.close();
    fs.writeFileSync(profile, Buffer.alloc(STATE_BYTES + 1));
    assert.throws(() => openProject(identity, '201', { home }), /PROJECT_STATE_INVALID/u);
    assert.equal(fs.statSync(profile).size, STATE_BYTES + 1);
    assert.equal(fs.existsSync(path.join(state.folder, 'project.lock')), false);
});
