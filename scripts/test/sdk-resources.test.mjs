import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { acquireSdk, sdkCache, validateSdk, verifyResources, archiveTool, resourceRoot } from '../sdk-resources.mjs';
import { releaseDependency } from '../sdk-release.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-resources-')));
    t.after(() => fs.rmSync(directory, { recursive: true }));
    const source = path.join(directory, 'source'), consumer = path.join(directory, 'consumer');
    fs.mkdirSync(path.join(consumer, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(resourceRoot, 'tools/SdkArchive.java'), path.join(consumer, 'tools/SdkArchive.java'));
    const files = new Map([
        ['tools/sdk-tools.jar', Buffer.from('test archive tool bytes')],
        ['tools/build-model.mjs', Buffer.from('export const value = 1;')],
        ['tools/community-model.gradle', Buffer.from('test model')],
        ['contracts/community/v1/community.schema.json', Buffer.from('{}')],
        ['contracts/community/v1/bundle-manifest.json', Buffer.from('{"test":true}')],
    ]);
    const version = '9.3.7', sourceCommit = 'a'.repeat(40);
    const tool = files.get('tools/sdk-tools.jar');
    files.set('tools/community-contract.json', Buffer.from(JSON.stringify({ sourceCommit, sdkVersion: version,
        tool: { path: 'tools/sdk-tools.jar', size: tool.length, sha256: hash(tool) },
        manifestSha256: hash(files.get('contracts/community/v1/bundle-manifest.json')) })));
    for (const [name, bytes] of files) {
        const file = path.join(source, name);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    }
    const archive = path.join(directory, 'sdk.zip');
    execFileSync('jar', ['--create', '--no-manifest', '--file', archive, '-C', source, '.'], { windowsHide: true });
    const bytes = fs.readFileSync(archive);
    const sdk = { version, sourceCommit, archive: { file: `PixivDownloader-Plugin-SDK-${version}.zip`, size: bytes.length, sha256: hash(bytes) },
        files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })) };
    const write = value => fs.writeFileSync(path.join(consumer, 'tools/submission-files.json'), JSON.stringify({ schemaVersion: 2, files: [], sdk: value }));
    write(sdk);
    let downloads = 0;
    const fetch = async (url, file, maximum, expected) => {
        downloads++;
        assert.equal(url, `https://github.com/Sywyar/PixivDownloader-Plugin-SDK/releases/download/sdk-api-v${version}/${sdk.archive.file}`);
        assert.equal(maximum, bytes.length); assert.equal(expected.sha256, hash(bytes));
        fs.writeFileSync(file, bytes, { flag: 'wx' });
        return { size: bytes.length, sha256: hash(bytes) };
    };
    return { directory, consumer, archive, sdk, bytes, files, write, fetch, downloads: () => downloads };
}

test('同一清单下载并校验 SDK 全部资源，缓存和并发获取复用同一发行字节', async t => {
    const f = fixture(t);
    const [a, b] = await Promise.all([acquireSdk(f.consumer, f.fetch), acquireSdk(f.consumer, f.fetch)]);
    assert.equal(a, b); assert.equal(f.downloads(), 1);
    assert.equal(verifyResources(a, f.sdk), true);
    for (const [file, bytes] of f.files) assert.deepEqual(fs.readFileSync(path.join(a, file)), bytes);
    assert.equal(await acquireSdk(f.consumer, () => assert.fail('warm cache downloaded')), a);
    assert(!fs.existsSync(a + '.lock'));
    fs.writeFileSync(path.join(a, 'tools/sdk-tools.jar'), 'changed');
    await assert.rejects(acquireSdk(f.consumer, f.fetch), /SDK_RESOURCE_CHANGED/);
    assert.equal(f.downloads(), 1);
});

test('坏归档、资源摘要和 SDK 来源不匹配均拒绝，失败不留下可执行缓存', async t => {
    const f = fixture(t);
    await assert.rejects(acquireSdk(f.consumer, async (_url, file) => fs.writeFileSync(file, 'bad')), /SDK_RESOURCE_CHANGED/);
    assert(!fs.existsSync(sdkCache(f.consumer, f.sdk)));
    const bad = structuredClone(f.sdk);
    bad.files[0].sha256 = 'b'.repeat(64); f.write(bad);
    await assert.rejects(acquireSdk(f.consumer, f.fetch), /SDK_RESOURCE_CHANGED/);
    assert(!fs.existsSync(sdkCache(f.consumer, bad)));
    const changed = { ...f.sdk, sourceCommit: 'c'.repeat(40) }; f.write(changed);
    await assert.rejects(acquireSdk(f.consumer, f.fetch), /SDK_SOURCE_MISMATCH/);
    assert(!fs.existsSync(sdkCache(f.consumer, changed)));
    assert(!fs.readdirSync(path.join(f.consumer, 'target/sdk')).some(name => name.includes('.tmp') || name.endsWith('.lock')));
});

test('运行清单拒绝路径逃逸、缺失资源、重复目标和额外依赖来源', t => {
    const f = fixture(t);
    for (const mutate of [
        s => { s.url = 'https://attacker.invalid/tool.jar'; },
        s => { s.version = 'latest'; },
        s => { s.archive.file = '../tool.zip'; },
        s => { s.files[0].path = '../tools/sdk-tools.jar'; },
        s => { s.files.push({ ...s.files[0] }); },
        s => { s.files.pop(); },
        s => { s.files[0].size = 64 * 1024 * 1024; },
    ]) { const value = structuredClone(f.sdk); mutate(value); assert.throws(() => validateSdk(value), /SDK_MANIFEST_INVALID/); }
    const cache = sdkCache(f.consumer, f.sdk);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.symlinkSync(f.directory, cache, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyResources(cache, f.sdk), /SDK_CACHE_PATH_INVALID/);
    fs.unlinkSync(cache);
});

test('维护入口仅接受指定公开发行，清单资源从实际 ZIP 生成并核验', async t => {
    const f = fixture(t);
    const release = { tag_name: `sdk-api-v${f.sdk.version}`, draft: false, published_at: '2024-01-01T00:00:00Z',
        assets: [{ name: f.sdk.archive.file, state: 'uploaded', size: f.bytes.length, digest: 'sha256:' + hash(f.bytes) }] };
    const dependency = await releaseDependency(f.sdk.version, f.consumer, { call: () => release, fetch: f.fetch });
    assert.equal(dependency.archive.sha256, f.sdk.archive.sha256);
    assert.deepEqual(new Set(dependency.files.map(f => f.path)), new Set(f.files.keys()));
    for (const changed of [{ ...release, draft: true }, { ...release, tag_name: 'sdk-api-v0.0.0' },
        { ...release, assets: [] }]) await assert.rejects(releaseDependency(f.sdk.version, f.consumer,
            { call: () => changed, fetch: () => assert.fail('invalid release downloaded') }), /SDK_RELEASE_/);
    assert.match(archiveTool(f.consumer, ['index', f.archive]), /tools\/sdk-tools.jar\t/);
});
