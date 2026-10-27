import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { download } from './download.mjs';
import { runTool } from './tool-process.mjs';
import { retryRequest } from './submission-retry.mjs';
import { observe } from './submission-progress.mjs';
import { api, API_TIMEOUT } from './github.mjs';
import { execFileSync } from 'node:child_process';
import { githubRequest, requestDetails } from './submission-github.mjs';

export const resourceRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const maximum = 64 * 1024 * 1024;
const relative = value => typeof value === 'string' && value.length <= 512
    && /^[A-Za-z0-9._/-]+$/u.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..');

export function foundationLock(directory = resourceRoot) {
    const file = path.join(directory, 'tools/foundation-lock.json');
    plainPath(file);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw new Error('FOUNDATION_LOCK_INVALID');
    const bytes = fs.readFileSync(file);
    const lock = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (lock.schemaVersion !== 1 || lock.repository !== 'Sywyar/PixivDownloader'
        || !/^[a-f0-9]{40}$/u.test(lock.sourceCommit) || /^0+$/u.test(lock.sourceCommit)
        || !Array.isArray(lock.files) || !Array.isArray(lock.libraries)
        || !lock.files.length || !lock.libraries.length || lock.files.length + lock.libraries.length > 512) {
        throw new Error('FOUNDATION_LOCK_INVALID');
    }
    const names = new Set();
    let total = 0;
    for (const [kind, files] of [['source', lock.files], ['library', lock.libraries]]) for (const entry of files) {
        const target = kind === 'source' ? entry.target : 'lib/' + path.posix.basename(entry.path);
        if (!relative(entry.path) || !relative(target) || names.has(target.toLowerCase())
            || !Number.isSafeInteger(entry.size) || entry.size < 1 || (total += entry.size) > maximum
            || !/^[a-f0-9]{64}$/u.test(entry.sha256) || /^0+$/u.test(entry.sha256)
            || kind === 'source' && !/^(src|resources|tools)\//u.test(target)
            || kind === 'library' && !entry.path.endsWith('.jar')) throw new Error('FOUNDATION_LOCK_INVALID');
        names.add(target.toLowerCase());
    }
    return { ...lock, sha256: hash(bytes) };
}

export function plainPath(file) {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && (stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())) {
            throw new Error('FOUNDATION_PATH_INVALID');
        }
        if (path.dirname(current) === current) break;
    }
}

export function fileMatches(file, entry) {
    plainPath(file);
    if (!fs.existsSync(file)) return false;
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== entry.size) throw new Error('FOUNDATION_RESOURCE_CHANGED');
    const input = fs.openSync(file, 'r');
    try {
        const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
        let total = 0;
        for (let count; (count = fs.readSync(input, buffer)) !== 0;) {
            if ((total += count) > entry.size) throw new Error('FOUNDATION_RESOURCE_CHANGED');
            digest.update(buffer.subarray(0, count));
        }
        if (total !== entry.size || digest.digest('hex') !== entry.sha256) throw new Error('FOUNDATION_RESOURCE_CHANGED');
    } finally { fs.closeSync(input); }
    return true;
}

export function foundationCache(directory, lock = foundationLock(directory)) {
    return path.join(directory, 'target/foundation', lock.sha256);
}

export function inputs(lock) {
    return [...lock.files,
    ...lock.libraries.map(file => ({ ...file, target: 'lib/' + path.posix.basename(file.path),
        url: 'https://repo.maven.apache.org/maven2/' + file.path }))];
}

export function readSourceBatch(lock, entries, deadline, execute = execFileSync) {
    const fields = entries.map((entry, i) => `f${i}: object(expression: ${JSON.stringify(lock.sourceCommit + ':' + entry.path)}) { ... on Blob { byteSize isBinary text } }`).join('\n');
    const query = `query { repository(owner: "Sywyar", name: "PixivDownloader") { ${fields} } }`;
    // 固定 Blob query 没有 mutation；HTTP POST 复用只读请求的重试和交互恢复。
    const output = githubRequest(timeout => observe('verifyingTools', '', () => execute('gh', ['api', 'graphql', '--input', '-'], {
            input: JSON.stringify({ query }), encoding: 'utf8', windowsHide: true,
            timeout, maxBuffer: Math.min(32 * 1024 * 1024, entries.reduce((n, entry) => n + entry.size * 6, 65536)),
            stdio: ['pipe', 'pipe', 'pipe'],
        })), { method: 'POST', readOnly: true, timeout: API_TIMEOUT, deadline });
    let response;
    try { response = JSON.parse(output); } catch { throw new Error('GITHUB_RESPONSE_INVALID'); }
    if (response.errors || !response.data?.repository) throw new Error('GITHUB_RESPONSE_INVALID');
    return entries.map((entry, i) => {
        const blob = response.data.repository['f' + i];
        if (blob?.byteSize !== entry.size || typeof blob.isBinary !== 'boolean') throw new Error('FOUNDATION_RESOURCE_CHANGED');
        if (blob.isBinary) return null;
        if (typeof blob.text !== 'string') throw new Error('FOUNDATION_RESOURCE_CHANGED');
        const bytes = Buffer.from(blob.text, 'utf8');
        // GraphQL 文本可能归一化换行；只有原始摘要吻合才使用，否则读取 Base64 原文。
        if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) return null;
        return bytes;
    });
}

export function acquireSources(directory = resourceRoot, call = api) {
    const lock = foundationLock(directory), cache = foundationCache(directory, lock);
    const deadline = Date.now() + 240000;
    const pending = lock.files.filter(entry => !fileMatches(path.join(cache, entry.target), entry));
    let batch = [];
    for (const [index, entry] of pending.entries()) {
        const file = path.join(cache, entry.target);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('FOUNDATION_TIMEOUT');
        if (call === api && index % 24 === 0) batch = readSourceBatch(lock, pending.slice(index, index + 24), deadline);
        let bytes = call === api ? batch[index % 24] : null;
        if (bytes === null) {
            const rawRemaining = deadline - Date.now();
            if (rawRemaining <= 0) throw new Error('FOUNDATION_TIMEOUT');
            const output = githubRequest(timeout => observe('verifyingTools', '', () => call(`repos/${lock.repository}/contents/${entry.path}?ref=${lock.sourceCommit}`,
                { repositoryName: lock.repository, raw: true }, (command, args, options) => execFileSync(command, args,
                    { ...options, timeout, maxBuffer: Math.min(32 * 1024 * 1024, Math.ceil(entry.size / 3) * 4 + 16384) }))),
                { timeout: API_TIMEOUT, deadline });
            let value;
            try { value = JSON.parse(output); } catch { throw new Error('GITHUB_RESPONSE_INVALID'); }
            const content = value?.content?.replaceAll('\n', '');
            if (value?.type !== 'file' || value.path !== entry.path || value.encoding !== 'base64'
                || value.size !== entry.size || typeof content !== 'string' || content.length > Math.ceil(entry.size / 3) * 4) {
                throw new Error('FOUNDATION_RESOURCE_CHANGED');
            }
            bytes = Buffer.from(content, 'base64');
            if (bytes.length !== entry.size || bytes.toString('base64') !== content || hash(bytes) !== entry.sha256) {
                throw new Error('FOUNDATION_RESOURCE_CHANGED');
            }
        }
        plainPath(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = file + '.' + crypto.randomUUID() + '.tmp';
        try {
            fs.writeFileSync(temporary, bytes, { flag: 'wx' });
            if (!fileMatches(file, entry)) fs.renameSync(temporary, file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    return { lock, directory: cache };
}

export function verifyFoundation(directory, lock) {
    let complete = true;
    for (const entry of inputs(lock)) if (!fileMatches(path.join(directory, entry.target), entry)) complete = false;
    return complete;
}

export async function acquireFoundation(directory = resourceRoot, fetch = download, call = api) {
    acquireSources(directory, call);
    const lock = foundationLock(directory), cache = foundationCache(directory, lock);
    plainPath(cache);
    fs.mkdirSync(cache, { recursive: true });
    // 每份内容独立按摘要缓存；并发下载只写自身随机临时文件。
    const pending = inputs(lock).filter(entry => entry.url && !fileMatches(path.join(cache, entry.target), entry));
    let index = 0;
    let failure;
    const deadline = Date.now() + 240000;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (!failure && index < pending.length) {
            const entry = pending[index++], file = path.join(cache, entry.target);
            const temporary = file + '.' + crypto.randomUUID() + '.tmp';
            try {
                plainPath(file);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new Error('FOUNDATION_TIMEOUT');
                await fetch(entry.url, temporary, entry.size, { size: entry.size, sha256: entry.sha256 },
                    { timeout: Math.min(60000, remaining) });
                fileMatches(temporary, entry);
                if (!fileMatches(file, entry)) fs.renameSync(temporary, file);
            } catch (error) { failure ??= error; }
            finally {
                try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
                catch (error) { failure ??= error; }
            }
        }
    }));
    if (failure) throw failure;
    if (!verifyFoundation(cache, lock)) throw new Error('FOUNDATION_RESOURCE_MISSING');
    return { lock, directory: cache };
}

export function ensureFoundation(directory = resourceRoot) {
    const lock = foundationLock(directory), cache = foundationCache(directory, lock);
    if (verifyFoundation(cache, lock)) return { lock, directory: cache };
    // 原生源码读取使用当前只读 GitHub 凭据；编译和依赖下载子进程继续剥离凭据。
    acquireSources(directory);
    let attempts = 0;
    for (let round = 1; ; round++) {
        try {
            observe('verifyingTools', '', () => runTool(process.execPath,
                [path.join(directory, 'scripts/foundation-resources.mjs'), 'fetch', directory], { timeout: 240000, maxBuffer: 65536 }));
            if (!verifyFoundation(cache, lock)) throw new Error('FOUNDATION_RESOURCE_MISSING');
            return { lock, directory: cache };
        } catch (error) {
            let detail;
            try { detail = JSON.parse(error.stdout); } catch { throw error; }
            const failure = Object.assign(new Error(detail.code), detail, { totalAttempts: attempts += detail.attempts ?? 0 });
            if (!failure.download || !failure.retryable) throw failure;
            if (!retryRequest(failure, round)) throw new Error('WIZARD_SAVE');
        }
    }
}

export function foundationResource(relative, directory = resourceRoot) {
    const ready = ensureFoundation(directory);
    const target = relative.startsWith('contracts/community/') ? relative.replace('contracts/', 'resources/') : relative;
    if (!ready.lock.files.some(file => file.target === target)) throw new Error('FOUNDATION_RESOURCE_INVALID');
    return path.join(ready.directory, target);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== 'fetch') throw new Error('FOUNDATION_ARGUMENTS');
        await acquireFoundation(path.resolve(process.argv[3]));
        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.log(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'FOUNDATION_DOWNLOAD_FAILED',
            download: error.download === true, retryable: error.retryable === true,
            ...(error.github ? { github: true, recoverable: error.recoverable !== false, ...requestDetails(error) } : {}),
            ...(error.attempts ? { attempts: error.attempts } : {}), ...(error.downloadStage ? { downloadStage: error.downloadStage } : {}),
            ...(error.status ? { status: error.status } : {}) }));
        process.exitCode = 1;
    }
}
