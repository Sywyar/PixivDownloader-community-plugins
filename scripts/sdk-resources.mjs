import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runTool } from './tool-process.mjs';
import { download } from './download.mjs';
import { retryRequest } from './submission-retry.mjs';
import { observe } from './submission-progress.mjs';

export const resourceRoot = fileURLToPath(new URL('../', import.meta.url));
export const SDK_REPOSITORY = 'Sywyar/PixivDownloader-Plugin-SDK';
export const SDK_MAX_BYTES = 192 * 1024 * 1024;
export const SDK_FILES_BYTES = 64 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const required = ['tools/sdk-tools.jar', 'tools/community-contract.json', 'tools/build-model.mjs',
    'tools/community-model.gradle', 'contracts/community/v1/bundle-manifest.json', 'contracts/community/v1/community.schema.json'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);

// 版本选择只来自受保护运行清单；下载器不查询 latest，也不接受投稿中的工具地址。
export function validateSdk(sdk) {
    if (!exact(sdk, ['version', 'sourceCommit', 'archive', 'files'])
        || typeof sdk.version !== 'string' || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.?[1-9]\d*)?$/u.test(sdk.version)
        || typeof sdk.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(sdk.sourceCommit) || /^0+$/u.test(sdk.sourceCommit)
        || !exact(sdk.archive, ['file', 'size', 'sha256'])
        || sdk.archive.file !== `PixivDownloader-Plugin-SDK-${sdk.version}.zip`
        || !Number.isSafeInteger(sdk.archive.size) || sdk.archive.size < 1 || sdk.archive.size > SDK_MAX_BYTES
        || !sha256(sdk.archive.sha256) || !Array.isArray(sdk.files) || !sdk.files.length || sdk.files.length > 256) {
        throw new Error('SDK_MANIFEST_INVALID');
    }
    const seen = new Set();
    let total = 0;
    for (const file of sdk.files) {
        if (!exact(file, ['path', 'size', 'sha256']) || typeof file.path !== 'string' || file.path.length > 512
            || !/^[A-Za-z0-9._/-]+$/u.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..')
            || !(required.includes(file.path) || file.path.startsWith('contracts/community/v1/'))
            || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 1
            || (total += file.size) > SDK_FILES_BYTES || !sha256(file.sha256)) throw new Error('SDK_MANIFEST_INVALID');
        seen.add(file.path.toLowerCase());
    }
    if (required.some(file => !seen.has(file))) throw new Error('SDK_MANIFEST_INVALID');
    return sdk;
}

export function sdkDependency(directory = resourceRoot) {
    const file = path.join(directory, 'tools/submission-files.json');
    plainPath(file);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 65536) throw new Error('SDK_MANIFEST_INVALID');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
    if (manifest.schemaVersion !== 2) throw new Error('SDK_MANIFEST_INVALID');
    return validateSdk(manifest.sdk);
}

export function plainPath(file) {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat && (stat.isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())) {
            throw new Error('SDK_CACHE_PATH_INVALID');
        }
        if (path.dirname(current) === current) break;
    }
}

export function fileMatches(file, expected) {
    plainPath(file);
    if (!fs.existsSync(file)) return false;
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size !== expected.size) throw new Error('SDK_RESOURCE_CHANGED');
    const input = fs.openSync(file, 'r');
    try {
        const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
        let total = 0;
        for (let count; (count = fs.readSync(input, buffer)) !== 0;) {
            total += count;
            if (total > expected.size) throw new Error('SDK_RESOURCE_CHANGED');
            hash.update(buffer.subarray(0, count));
        }
        if (total !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('SDK_RESOURCE_CHANGED');
    } finally { fs.closeSync(input); }
    return true;
}

export function sdkCache(directory, sdk) {
    return path.join(directory, 'target/sdk', digest(Buffer.from(JSON.stringify(validateSdk(sdk)))));
}

export function verifyResources(directory, sdk) {
    plainPath(directory);
    if (!fs.existsSync(directory)) return false;
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('SDK_CACHE_PATH_INVALID');
    for (const file of sdk.files) if (!fileMatches(path.join(directory, file.path), file)) throw new Error('SDK_RESOURCE_CHANGED');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'tools/community-contract.json'), 'utf8'));
    const tool = sdk.files.find(f => f.path === 'tools/sdk-tools.jar');
    const manifest = sdk.files.find(f => f.path === 'contracts/community/v1/bundle-manifest.json');
    if (metadata.sourceCommit !== sdk.sourceCommit || metadata.sdkVersion !== sdk.version
        || metadata.tool.path !== tool.path || metadata.tool.size !== tool.size || metadata.tool.sha256 !== tool.sha256
        || metadata.manifestSha256 !== manifest.sha256) throw new Error('SDK_SOURCE_MISMATCH');
    return true;
}

export function archiveTool(directory, args) {
    return runTool('java', ['-Dfile.encoding=UTF-8', '--source', '17', path.join(directory, 'tools/SdkArchive.java'), ...args],
        { maxBuffer: 65536 }).stdout;
}

export async function acquireSdk(directory = resourceRoot, fetch = download) {
    const sdk = sdkDependency(directory), cache = sdkCache(directory, sdk);
    if (verifyResources(cache, sdk)) return cache;
    plainPath(path.dirname(cache));
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const lock = cache + '.lock', deadline = Date.now() + 120000;
    for (;;) {
        try { fs.mkdirSync(lock); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            plainPath(lock);
            if (verifyResources(cache, sdk)) return cache;
            if (Date.now() >= deadline) throw new Error('SDK_CACHE_BUSY');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    let staging;
    try {
        if (verifyResources(cache, sdk)) return cache;
        const archive = path.join(path.dirname(cache), sdk.archive.sha256 + '.zip');
        if (!fileMatches(archive, sdk.archive)) {
            const temporary = archive + '.' + crypto.randomUUID() + '.tmp';
            try {
                await fetch(`https://github.com/${SDK_REPOSITORY}/releases/download/sdk-api-v${sdk.version}/${sdk.archive.file}`,
                    temporary, sdk.archive.size, sdk.archive);
                if (!fileMatches(temporary, sdk.archive)) throw new Error('SDK_RESOURCE_CHANGED');
                fs.renameSync(temporary, archive);
            } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
        staging = fs.mkdtempSync(cache + '.tmp-');
        const selection = path.join(staging, 'selection.txt');
        fs.writeFileSync(selection, sdk.files.map(f => `${f.path}\t${f.size}\t${f.sha256}`).join('\n'), { flag: 'wx' });
        archiveTool(directory, ['extract', archive, staging, selection]);
        fs.unlinkSync(selection);
        verifyResources(staging, sdk);
        fs.renameSync(staging, cache);
        staging = null;
        return cache;
    } finally {
        // 只清理本次创建的临时目录，已验证缓存和其它调用的锁不受影响。
        if (staging) { plainPath(staging); fs.rmSync(staging, { recursive: true }); }
        fs.rmdirSync(lock);
    }
}

export function ensureSdk(directory = resourceRoot) {
    const sdk = sdkDependency(directory), cache = sdkCache(directory, sdk);
    if (verifyResources(cache, sdk)) return { sdk, directory: cache };
    let attempts = 0;
    for (let round = 1; ; round++) {
        try {
            observe('verifyingTools', '', () => runTool(process.execPath, [path.join(directory, 'scripts/sdk-resources.mjs'), 'fetch', directory],
                { timeout: 240000, maxBuffer: 65536 }));
            if (!verifyResources(cache, sdk)) throw new Error('SDK_RESOURCE_CHANGED');
            return { sdk, directory: cache };
        } catch (error) {
            let detail;
            try { detail = JSON.parse(error.stdout); } catch { throw error; }
            const failure = Object.assign(new Error(detail.code), detail, { totalAttempts: attempts += detail.attempts ?? 0 });
            if (!failure.download || !failure.retryable) throw failure;
            if (!retryRequest(failure, round)) throw new Error('WIZARD_SAVE');
        }
    }
}

export function sdkResource(relative, directory = resourceRoot) {
    const ready = ensureSdk(directory);
    if (!ready.sdk.files.some(f => f.path === relative)) throw new Error('SDK_RESOURCE_INVALID');
    return path.join(ready.directory, relative);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== 'fetch') throw new Error('SDK_RESOURCE_ARGUMENTS');
        await acquireSdk(path.resolve(process.argv[3]));
        console.log(JSON.stringify({ ok: true }));
    } catch (error) {
        console.log(JSON.stringify({ code: /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'SDK_DOWNLOAD_FAILED',
            download: error.download === true, retryable: error.retryable === true,
            ...(error.attempts ? { attempts: error.attempts } : {}), ...(error.downloadStage ? { downloadStage: error.downloadStage } : {}),
            ...(error.status ? { status: error.status } : {}) }));
        process.exitCode = 1;
    }
}
