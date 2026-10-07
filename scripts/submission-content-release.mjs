import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { github, paged, unchanged, checkedRepository } from './submission-github.mjs';
import { id } from './github.mjs';
import { hash } from './sdk.mjs';
import { readFile } from './submission-fields.mjs';
import { download } from './download.mjs';
import { downloadGithubBinary, uploadGithubBinary } from './candidate-transfer.mjs';
import { contentTag } from './submission-content.mjs';
import { retryStep } from './submission-retry.mjs';

// 投稿前的内容暂存与固定两附件的源码候选分离；社区审核仍复制并核验全部原字节。
export function contentRelease(context, submission, files = new Map(), options = {}) {
    const { sdk, call = github } = context;
    const transfer = options.transfer ?? downloadGithubBinary, upload = options.upload ?? uploadGithubBinary;
    const publicDownload = options.download ?? download;
    if (!submission.content) return { actions: [], beforeWrite: async () => {}, fetch: publicDownload };
    const expected = sdk.invoke({ command: 'content', value: submission.content, locale: submission.market.defaultLocale });
    const repository = new URL(submission.source.repository).pathname.slice(1);
    const prefix = `repos/${repository}`, tag = contentTag(submission.pluginId, submission.version);
    const base = `${submission.source.repository}/releases/download/${encodeURIComponent(tag)}/`;
    for (const asset of Object.values(expected)) {
        if (asset.url !== base + asset.name || !/^content-[a-f0-9]{64}\.(?:md|html|png|jpg|webp)$/u.test(asset.name)
            || !asset.name.startsWith(`content-${asset.sha256}.`)) throw new Error('CONTENT_ASSET_CHANGED');
        const bytes = files.get(asset.name);
        if (!bytes || bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error('CONTENT_ASSET_CHANGED');
    }
    const fetch = async (url, destination, maximum, requested) => {
        const asset = Object.values(expected).find(asset => asset.url === url);
        if (!asset) return publicDownload(url, destination, maximum, requested);
        if (!requested || requested.size !== asset.size || requested.sha256 !== asset.sha256 || asset.size > maximum) throw new Error('CONTENT_ASSET_CHANGED');
        fs.writeFileSync(destination, files.get(asset.name), { flag: 'wx' });
        return { url, size: asset.size, sha256: asset.sha256 };
    };
    const beforeWrite = async () => {
        const repositoryId = id(checkedRepository(repository, call).id);
        const step = work => retryStep('uploadingCandidate', () => {
            if (context.snapshot) unchanged(context.snapshot, call);
            if (id(checkedRepository(repository, call).id) !== repositoryId) throw new Error('CONTENT_ASSET_CHANGED');
            return work();
        });
        const findRelease = () => {
            const found = paged(`${prefix}/releases`, call).filter(item => item.tag_name === tag);
            if (found.length > 1) throw new Error('CONTENT_RELEASE_CONFLICT');
            return found[0];
        };
        const release = await step(() => {
            const existing = findRelease();
            if (existing) return existing;
            try { return call(`${prefix}/releases`, { method: 'POST', body: { tag_name: tag,
                target_commitish: submission.source.commit, name: `${submission.pluginId} ${submission.version} market content`,
                body: 'Content attachments for community review. This release does not publish or approve the plugin.',
                draft: true, prerelease: true, make_latest: 'false' } }); }
            catch (error) { const found = error.github && findRelease(); if (!found) throw error; return found; }
        });
        if (release.tag_name !== tag || !release.prerelease) throw new Error('CONTENT_RELEASE_CONFLICT');
        const assets = () => paged(`${prefix}/releases/${id(release.id)}/assets`, call);
        for (const asset of Object.values(expected)) {
            const file = sdk.save(files.get(asset.name), path.extname(asset.name));
            const find = () => {
                const found = assets().filter(item => item.name === asset.name);
                if (found.length > 1) throw new Error('CONTENT_ASSET_CHANGED');
                return found[0];
            };
            const remote = await step(() => {
                const existing = find();
                if (existing) return existing;
                try { return upload(prefix, id(release.id), file, asset.name); }
                catch (error) { const found = error.github && find(); if (!found) throw error; return found; }
            });
            if (remote.size !== asset.size || remote.digest !== `sha256:${asset.sha256}` || remote.state !== 'uploaded') throw new Error('CONTENT_ASSET_CHANGED');
            await transfer(`${prefix}/releases/assets/${id(remote.id)}`, path.join(sdk.workspace, randomUUID() + '.content'), asset.size, asset);
        }
        await step(() => {
            const current = call(`${prefix}/releases/${id(release.id)}`);
            if (current.tag_name !== tag || !current.prerelease) throw new Error('CONTENT_RELEASE_CONFLICT');
            if (!current.draft) return current;
            try { return call(`${prefix}/releases/${id(release.id)}`, { method: 'PATCH', body: { draft: false, prerelease: true, make_latest: 'false' } }); }
            catch (error) { const now = error.github && call(`${prefix}/releases/${id(release.id)}`); if (!now || now.draft) throw error; return now; }
        });
        const current = call(`${prefix}/releases/${id(release.id)}`);
        if (current.draft || !current.prerelease || current.tag_name !== tag) throw new Error('CONTENT_RELEASE_CONFLICT');
        for (const asset of Object.values(expected)) {
            const file = path.join(sdk.workspace, randomUUID() + '.content');
            await publicDownload(asset.url, file, asset.size, asset);
            const bytes = readFile(file, asset.size);
            if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error('CONTENT_ASSET_CHANGED');
        }
    };
    return { actions: ['PUBLISH_MARKET_CONTENT'], beforeWrite, fetch };
}
