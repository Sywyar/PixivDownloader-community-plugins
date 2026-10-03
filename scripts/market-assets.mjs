import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash } from './sdk.mjs';
import { API_BYTES } from './github.mjs';

export const isMarketAsset = name => /^(?:content-[a-f0-9]{64}\.(?:md|html|png|jpg|webp)|market-[a-f0-9]{64}\.(?:png|jpg|webp))$/u.test(name);
export const marketImageName = image => 'market-' + path.posix.basename(image.path);
export const candidateBudget = sdk => 2 * sdk.invoke({ command: 'limits' }).maxArchiveBytes + API_BYTES
    + sdk.invoke({ command: 'content-limits' }).releaseBytes;

export function checkedMarketFiles(checked) {
    const files = new Map();
    const add = file => {
        const previous = files.get(file.path);
        if (!isMarketAsset(file.path) || previous && (previous.sha256 !== file.sha256 || previous.size !== file.size)) throw new Error('CONTENT_ASSET_CHANGED');
        files.set(file.path, file);
    };
    for (const asset of Object.values(checked.contentAssets ?? {})) add({ path: asset.name, size: asset.size, sha256: asset.sha256,
        source: path.join(checked.contentRoot, asset.name) });
    const images = [checked.submission.market.icon, ...(checked.submission.market.screenshots ?? [])].filter(Boolean);
    if (images.length !== (checked.images?.length ?? 0)) throw new Error('CONTENT_ASSET_CHANGED');
    images.forEach((image, index) => {
        if (image.asset) add({ path: marketImageName(image), size: checked.images[index].size,
            sha256: checked.images[index].sha256, source: path.join(checked.imagesRoot, image.path) });
    });
    return [...files.values()];
}

export function verifyCandidateMarket(candidate, checked) {
    const compact = files => files.map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    if (!isDeepStrictEqual(compact(candidate.files.filter(file => isMarketAsset(file.path))), compact(checkedMarketFiles(checked)))) {
        throw new Error('CONTENT_ASSET_CHANGED');
    }
}

export function publishedContent(content, baseUrl) {
    if (!content) return undefined;
    const result = structuredClone(content);
    for (const group of Object.values(result)) for (const document of Object.values(group)) {
        document.asset.url = baseUrl + encodeURIComponent(document.asset.name);
        for (const asset of Object.values(document.resources ?? {})) asset.url = baseUrl + encodeURIComponent(asset.name);
    }
    return result;
}

export function publishedImage(image, baseUrl, bytes) {
    if (!image) return undefined;
    if (!bytes) throw new Error('MARKET_IMAGE_MISSING');
    const name = marketImageName(image), sha256 = hash(bytes), extension = path.posix.extname(name);
    if (name !== `market-${sha256}${extension}`) throw new Error('CONTENT_ASSET_CHANGED');
    return { ...image, asset: { name, url: baseUrl + name, size: bytes.length, sha256,
        mediaType: { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[extension] } };
}
