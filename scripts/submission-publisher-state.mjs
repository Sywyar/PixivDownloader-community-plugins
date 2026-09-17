import fs from 'node:fs';
import path from 'node:path';
import { hash } from './sdk.mjs';
import { readFile } from './submission-fields.mjs';
import { lockState, submissionHome, writeState, STATE_BYTES } from './submission-state.mjs';

const fields = ['keyId', 'fingerprint', 'publicFile', 'privateFile', 'directory'];
const fingerprintPattern = /^[a-f0-9]{64}$/u;

export function publisherIdentity(owner) {
    if (!/^[1-9][0-9]*$/u.test(String(owner?.accountId)) || !['User', 'Organization'].includes(owner?.accountType)
        || typeof owner?.publisherId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(owner.publisherId)) throw new Error('PUBLISHER_IDENTITY_INVALID');
    return { host: 'github.com', accountId: String(owner.accountId), accountType: owner.accountType, publisherId: owner.publisherId };
}

// 跨工程只共享已核对的密钥定位信息；读写时短暂加锁，不占用其它工程的会话。
export function publisherKeys(owner, actorId, { home = submissionHome() } = {}) {
    const identity = publisherIdentity(owner);
    if (!/^[1-9][0-9]*$/u.test(String(actorId))) throw new Error('PUBLISHER_IDENTITY_INVALID');
    const folder = path.resolve(home, 'publishers', hash(Buffer.from(JSON.stringify(identity))));
    const file = path.join(folder, 'profile.json');
    const access = (change) => {
        const release = lockState(folder, 'publisher.lock', 'PUBLISHER_STATE_LOCKED');
        try {
            let data;
            try {
                data = fs.existsSync(file) ? JSON.parse(readFile(file, STATE_BYTES).toString('utf8'))
                    : { schemaVersion: 1, identity, actors: {} };
                if (data.schemaVersion !== 1 || JSON.stringify(data.identity) !== JSON.stringify(identity)
                    || !data.actors || typeof data.actors !== 'object' || Array.isArray(data.actors)) throw new Error();
                for (const [actorId, actor] of Object.entries(data.actors)) {
                    if (!actor || !actor.keys || typeof actor.keys !== 'object' || Array.isArray(actor.keys)
                        || !/^[1-9][0-9]*$/u.test(actorId)
                        || Object.keys(actor).some(key => !['keys', 'last'].includes(key))
                        || Object.entries(actor.keys).some(([fingerprint, key]) => !fingerprintPattern.test(fingerprint)
                            || key?.fingerprint !== fingerprint || typeof key.keyId !== 'string' || !key.keyId
                            || Object.entries(key).some(([name, value]) => !fields.includes(name) || typeof value !== 'string'))
                        || actor.last !== undefined && !Object.hasOwn(actor.keys, actor.last)) throw new Error();
                    const ids = Object.values(actor.keys).map(key => key.keyId);
                    if (new Set(ids).size !== ids.length) throw new Error();
                }
            } catch { throw Object.assign(new Error('PUBLISHER_STATE_INVALID'), { statePath: file }); }
            const actor = data.actors[String(actorId)] ??= { keys: {} };
            if (change) {
                change(actor);
                try { writeState(file, data, 'PUBLISHER_STATE_SIZE_EXCEEDED'); }
                catch (error) { throw Object.assign(error, { statePath: file }); }
            }
            return structuredClone({ keys: actor.keys, key: actor.keys[actor.last] });
        } finally { release(); }
    };
    return { identity, folder,
        get record() { return access(); },
        key(fingerprint) { return access().keys[fingerprint]; },
        update({ key }, { selected = true } = {}) {
            const value = Object.fromEntries(fields.filter(field => typeof key?.[field] === 'string').map(field => [field, key[field]]));
            if (!fingerprintPattern.test(value.fingerprint) || !value.keyId) throw new Error('PUBLISHER_STATE_INVALID');
            access(actor => {
                if (Object.values(actor.keys).some(previous => previous.fingerprint !== value.fingerprint && previous.keyId === value.keyId)) {
                    throw new Error('KEY_ID_REUSED');
                }
                actor.keys[value.fingerprint] = { ...actor.keys[value.fingerprint], ...value };
                if (selected) actor.last = value.fingerprint;
            });
        } };
}
