import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash } from './sdk.mjs';
import { readFile } from './submission-fields.mjs';

export const STATE_BYTES = 1024 * 1024;
export const CACHE_BYTES = 768 * 1024 * 1024;
export const CACHE_FILES = 8;
const fields = new Set(['profile', 'artifact', 'licenseFiles', 'license', 'locale', 'name', 'summary', 'description',
    'category', 'tags', 'icon', 'screenshots', 'alt', 'homepage', 'owner', 'organization', 'publisher', 'display',
    'publicKey', 'privateKey', 'keyId', 'keyDirectory', 'keyAction', 'imageAction']);

export function submissionHome() {
    const base = process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local')
        : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
            : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state');
    return path.join(base, 'PixivDownloader/community-submission');
}

export function projectIdentity(repositoryId, projectDir, pluginId) {
    if (!/^[1-9][0-9]*$/u.test(String(repositoryId)) || typeof projectDir !== 'string'
        || !projectDir || projectDir.includes('\\') || projectDir !== '.' && projectDir.split('/').some(p => !p || p === '.' || p === '..')
        || typeof pluginId !== 'string' || !pluginId) throw new Error('PROJECT_IDENTITY_INVALID');
    return { host: 'github.com', repositoryId: String(repositoryId), projectDir, pluginId };
}

export function stateDirectory(file) {
    const absolute = path.resolve(file);
    const parent = path.dirname(absolute);
    if (!fs.existsSync(absolute)) { if (parent !== absolute) stateDirectory(parent); fs.mkdirSync(absolute, { mode: 0o700 }); }
    if (!fs.lstatSync(file).isDirectory() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('STATE_PATH_INVALID');
}

export function writeState(file, value) {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    if (bytes.length > STATE_BYTES) throw new Error('PROJECT_STATE_SIZE_EXCEEDED');
    stateDirectory(path.dirname(file));
    if (fs.existsSync(file)) readFile(file, STATE_BYTES);
    const temporary = path.join(path.dirname(file), randomUUID() + '.tmp');
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function projectFolder(identity, home = submissionHome()) {
    return path.resolve(home, 'projects', hash(Buffer.from(JSON.stringify(projectIdentity(identity.repositoryId, identity.projectDir, identity.pluginId)))));
}

// 项目数据不是授权源；每次使用都重新核对平台身份、源码和包字节。
export function openProject(identity, actorId, { home = submissionHome() } = {}) {
    if (!/^[1-9][0-9]*$/u.test(String(actorId))) throw new Error('PROJECT_IDENTITY_INVALID');
    const folder = projectFolder(identity, home);
    stateDirectory(folder);
    const lockFile = path.join(folder, 'project.lock');
    const lock = Buffer.from(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    try { fs.writeFileSync(lockFile, lock, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const bytes = readFile(lockFile, 1024);
        let owner;
        try { owner = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('PROJECT_STATE_LOCKED'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('PROJECT_STATE_LOCKED');
        try { process.kill(owner.pid, 0); throw new Error('PROJECT_STATE_LOCKED'); }
        catch (busy) { if (busy.code !== 'ESRCH') throw new Error('PROJECT_STATE_LOCKED'); }
        if (!readFile(lockFile, 1024).equals(bytes)) throw new Error('PROJECT_STATE_LOCKED');
        fs.unlinkSync(lockFile);
        fs.writeFileSync(lockFile, lock, { flag: 'wx', mode: 0o600 });
    }
    let closed = false;
    const release = () => { if (!closed && readFile(lockFile, 1024).equals(lock)) fs.unlinkSync(lockFile); closed = true; };
    const file = path.join(folder, 'profile.json');
    let data;
    try {
        data = fs.existsSync(file) ? JSON.parse(readFile(file, STATE_BYTES).toString('utf8'))
            : { schemaVersion: 1, identity, actors: {} };
        if (data.schemaVersion !== 1 || JSON.stringify(data.identity) !== JSON.stringify(identity)
            || !data.actors || typeof data.actors !== 'object' || Array.isArray(data.actors)) throw new Error('PROJECT_STATE_INVALID');
    } catch (error) { release(); throw Object.assign(new Error('PROJECT_STATE_INVALID'), { statePath: file }); }
    const actor = data.actors[String(actorId)] ??= { answers: {}, history: [] };
    if (!actor || typeof actor !== 'object' || !actor.answers || typeof actor.answers !== 'object'
        || Array.isArray(actor.answers) || !Array.isArray(actor.history) || actor.history.length > 20) { release(); throw new Error('PROJECT_STATE_INVALID'); }
    const save = () => writeState(file, data);
    const prunePending = () => {
        const retained = new Set(Object.values(data.actors).map(record => record.session?.prepared?.digest));
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const match = /^pending-([a-f0-9]{64})\.bin$/u.exec(entry.name);
            if (!match || retained.has(match[1])) continue;
            const candidate = path.join(folder, entry.name);
            if (!entry.isFile() || fs.realpathSync(candidate) !== candidate) throw new Error('STATE_PATH_INVALID');
            fs.unlinkSync(candidate);
        }
    };
    try { prunePending(); } catch (error) { release(); throw error; }
    const answer = (name, fallback) => Object.hasOwn(actor.answers, name) ? structuredClone(actor.answers[name]) : fallback;
    const remember = (name, value) => {
        if (!fields.has(name.split(':')[0])) return;
        actor.answers[name] = structuredClone(value);
        save();
    };
    const cache = path.join(folder, 'cache');
    try { stateDirectory(cache); } catch (error) { release(); throw error; }
    const cachePath = digest => {
        if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('CACHE_DIGEST_INVALID');
        return path.join(cache, digest);
    };
    const cached = (digest, size) => {
        if (!Number.isSafeInteger(size) || size < 1 || size > CACHE_BYTES) throw new Error('CACHE_SIZE_EXCEEDED');
        const target = cachePath(digest);
        if (!fs.existsSync(target)) return null;
        const bytes = readFile(target, Math.min(size, CACHE_BYTES));
        if (bytes.length !== size || hash(bytes) !== digest) throw new Error('CACHE_DIGEST_CHANGED');
        fs.utimesSync(target, new Date(), new Date());
        return target;
    };
    const retain = (source, digest, size) => {
        if (cached(digest, size)) return cachePath(digest);
        const bytes = readFile(source, Math.min(size, CACHE_BYTES));
        if (bytes.length !== size || hash(bytes) !== digest) throw new Error('CACHE_DIGEST_CHANGED');
        const names = [];
        const listing = fs.opendirSync(cache);
        try { for (let entry; (entry = listing.readSync());) { if (names.length >= CACHE_FILES) throw new Error('CACHE_ENTRY_LIMIT'); names.push(entry.name); } }
        finally { listing.closeSync(); }
        const entries = names.map(name => {
            if (!/^[a-f0-9]{64}$/u.test(name)) throw new Error('CACHE_PATH_INVALID');
            const target = cachePath(name); const stat = fs.lstatSync(target);
            if (!stat.isFile()) throw new Error('CACHE_PATH_INVALID');
            return { target, size: stat.size, used: stat.mtimeMs };
        }).sort((a, b) => a.used - b.used);
        let total = entries.reduce((sum, item) => sum + item.size, size);
        while (entries.length >= CACHE_FILES || total > CACHE_BYTES) {
            const old = entries.shift();
            if (!old) throw new Error('CACHE_SIZE_EXCEEDED');
            fs.unlinkSync(old.target); total -= old.size;
        }
        fs.writeFileSync(cachePath(digest), bytes, { flag: 'wx', mode: 0o600 });
        return cachePath(digest);
    };
    return { identity, folder, answer, remember, cached, retain, close: release,
        get record() { return structuredClone(actor); },
        update(values) {
            for (const field of ['key', 'license', 'market', 'marketAssets', 'receipt', 'session']) if (Object.hasOwn(values, field)) {
                if (field === 'key') {
                    actor.key = Object.fromEntries(['keyId', 'fingerprint', 'publicFile', 'privateFile', 'directory']
                        .filter(key => typeof values.key[key] === 'string').map(key => [key, values.key[key]]));
                } else actor[field] = structuredClone(values[field]);
            }
            save();
            prunePending();
        },
        complete(receipt) {
            actor.receipt = receipt;
            actor.session = null;
            actor.history = [...actor.history.slice(-19), { ...receipt, completedAt: new Date().toISOString() }];
            save();
            prunePending();
        } };
}
