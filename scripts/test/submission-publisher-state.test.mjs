import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { publisherKeys } from '../submission-publisher-state.mjs';
import { lockState, STATE_BYTES } from '../submission-state.mjs';

test('发布者密钥跨工程复用，账号与发布者隔离，指纹更新路径且不保存秘密', t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-state-'));
    t.after(() => fs.rmSync(home, { recursive: true }));
    const owner = { accountId: '101', accountType: 'User', publisherId: 'example' };
    const first = publisherKeys(owner, '101', { home }), second = publisherKeys(owner, '101', { home });
    const fingerprint = 'a'.repeat(64), key = { fingerprint, keyId: 'first', publicFile: '/public.pem', privateFile: '/private.pem' };
    first.update({ key: { ...key, password: 'secret-password', privateBytes: 'secret-bytes' } });
    assert.deepEqual(second.key(fingerprint), key);
    second.update({ key: { ...key, privateFile: '/verified-private.pem' } });
    assert.equal(first.key(fingerprint).privateFile, '/verified-private.pem');
    first.update({ key: { fingerprint: 'b'.repeat(64), keyId: 'next' } });
    second.update({ key: { ...key, privateFile: '/current-proof.pem' } }, { selected: false });
    assert.equal(first.record.key.keyId, 'next');
    for (const [other, actor] of [[owner, '202'], [{ ...owner, publisherId: 'another' }, '101'],
        [{ ...owner, accountId: '202' }, '101'], [{ ...owner, accountType: 'Organization' }, '101']]) {
        assert.equal(publisherKeys(other, actor, { home }).key(fingerprint), undefined);
    }
    const file = path.join(first.folder, 'profile.json'), original = fs.readFileSync(file);
    assert(!original.includes(Buffer.from('secret-')));
    assert.throws(() => first.update({ key: { ...key, fingerprint: 'c'.repeat(64) } }), /KEY_ID_REUSED/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.throws(() => first.update({ key: { ...key, privateFile: 'x'.repeat(STATE_BYTES) } }), /PUBLISHER_STATE_SIZE_EXCEEDED/);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(fs.existsSync(path.join(first.folder, 'publisher.lock')), false);
    const release = lockState(first.folder, 'publisher.lock', 'PUBLISHER_STATE_LOCKED');
    try { assert.throws(() => second.key(fingerprint), /PUBLISHER_STATE_LOCKED/); } finally { release(); }
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => first.key(fingerprint), /PUBLISHER_STATE_INVALID/);
    assert.equal(fs.existsSync(path.join(first.folder, 'publisher.lock')), false);
});
