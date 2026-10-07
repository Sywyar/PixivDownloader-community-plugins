import fs from 'node:fs';
import path from 'node:path';
import { api, main } from './github.mjs';
import { download } from './download.mjs';
import { submissionManifest } from './submission-manifest.mjs';
import { archiveTool, fileMatches, plainPath, validateSdk, verifyResources, SDK_REPOSITORY, SDK_MAX_BYTES, resourceRoot } from './sdk-resources.mjs';

// 维护入口只选择指定的公开发行；正常启动完全使用已签名运行清单。
export async function releaseDependency(version, directory = resourceRoot, { call = api, fetch = download } = {}) {
    if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.?[1-9]\d*)?$/u.test(version)) throw new Error('SDK_VERSION_INVALID');
    const tag = `sdk-api-v${version}`;
    const release = call(`repos/${SDK_REPOSITORY}/releases/tags/${tag}`, { repositoryName: SDK_REPOSITORY });
    if (release.draft !== false || release.tag_name !== tag || !release.published_at) throw new Error('SDK_RELEASE_NOT_PUBLIC');
    const name = `PixivDownloader-Plugin-SDK-${version}.zip`;
    const assets = release.assets?.filter(a => a.name === name) ?? [];
    if (assets.length !== 1 || assets[0].state !== 'uploaded' || !Number.isSafeInteger(assets[0].size)
        || assets[0].size < 1 || assets[0].size > SDK_MAX_BYTES || !/^sha256:[a-f0-9]{64}$/u.test(assets[0].digest)) {
        throw new Error('SDK_RELEASE_INVALID');
    }
    const archive = { file: name, size: assets[0].size, sha256: assets[0].digest.slice(7) };
    plainPath(path.join(directory, 'target'));
    fs.mkdirSync(path.join(directory, 'target'), { recursive: true });
    const temporary = fs.mkdtempSync(path.join(directory, 'target/sdk-release-'));
    try {
        const file = path.join(temporary, 'sdk.zip');
        await fetch(`https://github.com/${SDK_REPOSITORY}/releases/download/${tag}/${name}`, file, archive.size, archive);
        if (!fileMatches(file, archive)) throw new Error('SDK_RESOURCE_CHANGED');
        const files = archiveTool(directory, ['index', file]).trim().split(/\r?\n/u).map(line => {
            const [file, size, sha256] = line.split('\t');
            return { path: file, size: Number(size), sha256 };
        }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
        const selection = path.join(temporary, 'selection.txt'), unpacked = path.join(temporary, 'unpacked');
        fs.mkdirSync(unpacked);
        fs.writeFileSync(selection, files.map(f => `${f.path}\t${f.size}\t${f.sha256}`).join('\n'));
        archiveTool(directory, ['extract', file, unpacked, selection]);
        const metadata = JSON.parse(fs.readFileSync(path.join(unpacked, 'tools/community-contract.json'), 'utf8'));
        const sdk = validateSdk({ version, sourceCommit: metadata.sourceCommit, archive, files });
        verifyResources(unpacked, sdk);
        return sdk;
    } finally { fs.rmSync(temporary, { recursive: true }); }
}

main(import.meta.url, async () => {
    if (process.argv.length !== 4 || process.argv[2] !== '--version') throw new Error('SDK_RELEASE_ARGUMENTS');
    const sdk = await releaseDependency(process.argv[3]);
    const manifest = submissionManifest(resourceRoot, sdk);
    fs.writeFileSync(path.join(resourceRoot, 'tools/submission-files.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ version: sdk.version, sourceCommit: sdk.sourceCommit, sha256: sdk.archive.sha256 }));
});
