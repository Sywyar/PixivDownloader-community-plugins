import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { downloadCandidate } from './candidate-transfer.mjs';
import { immutableAsset, readReceipt } from './apply-result.mjs';
import { stateReader } from './submission-github.mjs';
import { formalTag, packageName, encoded, releaseStatus } from './apply-generation.mjs';
export { releaseStatus };
import { download as publicDownload } from './download.mjs';

function tagCommit(tag, call) {
    const refs = list(`${prefix}/git/matching-refs/tags/${tag}`, null, call).filter(ref => ref.ref === 'refs/tags/' + tag);
    if (!refs.length) return null;
    if (refs.length !== 1 || refs[0].object.type !== 'commit') throw new Error('PUBLICATION_TAG_CHANGED');
    return sha(refs[0].object.sha);
}

const assetIdentity = ({ id, name, size, digest, state }) => ({ id, name, size, digest, state });

export async function promoteReleases(receipt, workspace, { call = api, download = downloadCandidate, fetch = publicDownload, ...transport } = {}) {
    for (const expected of receipt.releases) {
        const directory = fs.mkdtempSync(path.join(workspace, 'promote-'));
        const read = () => {
            const release = call(`${prefix}/releases/${id(expected.id)}`);
            if (release.draft ? release.tag_name !== expected.originalTag || release.published_at !== null
                : release.tag_name !== expected.tag || release.target_commitish !== expected.targetCommit) throw new Error('PUBLICATION_RELEASE_CHANGED');
            const assets = list(`${prefix}/releases/${id(expected.id)}/assets`, null, call);
            for (const original of expected.originalAssets) {
                const matches = assets.filter(asset => asset.name === original.name);
                if (matches.length !== 1 || !isDeepStrictEqual(assetIdentity(matches[0]), original)) throw new Error('PUBLICATION_ASSET_CHANGED');
            }
            const known = new Set([...expected.originalAssets.map(asset => asset.name), 'review.json', 'community-signature.json']);
            if (assets.some(asset => !known.has(asset.name))) throw new Error('PUBLICATION_ASSET_CHANGED');
            return { release, assets };
        };
        const initial = read();
        const artifact = initial.assets.find(asset => asset.name === expected.packageName);
        if (!artifact || artifact.size !== expected.packageSize || artifact.digest !== `sha256:${expected.packageSha256}`) throw new Error('PUBLICATION_PACKAGE_CHANGED');
        await download(`${prefix}/releases/assets/${id(artifact.id)}`, path.join(directory, 'package'), expected.packageSize,
            { size: expected.packageSize, sha256: expected.packageSha256 });
        for (const [name, bytes] of [['review.json', Buffer.from(expected.reviewBytes, 'base64')], ['community-signature.json', encoded(expected.signature)]]) {
            const file = path.join(directory, name); fs.writeFileSync(file, bytes, { flag: 'wx' });
            await immutableAsset(expected.id, file, name, { call, download, ...transport });
        }
        const target = tagCommit(expected.tag, call);
        if (target && target !== expected.targetCommit) throw new Error('PUBLICATION_TAG_CHANGED');
        const ready = read();
        if (ready.release.draft) {
            const body = `Publisher: ${expected.owner.publisherId} (${expected.owner.accountType} ${expected.owner.accountId})\n`
                + `Source commit: ${expected.sourceCommit}\nSHA-256: ${expected.packageSha256}\n\nAwaiting the verified generation result PR. Publication assets alone do not grant catalog admission.`;
            try { call(`${prefix}/releases/${id(expected.id)}`, { method: 'PATCH', body: { tag_name: expected.tag,
                target_commitish: expected.targetCommit, name: expected.name, body, draft: false,
                prerelease: /-(?:alpha|beta|rc)(?:\.?[0-9]+)?(?:\+.*)?$/u.test(expected.version), make_latest: 'false' } }); }
            catch (error) { if (call(`${prefix}/releases/${id(expected.id)}`).draft) throw error; }
        }
        const published = read();
        if (published.release.draft || !published.release.published_at || tagCommit(expected.tag, call) !== expected.targetCommit) throw new Error('PUBLICATION_READBACK_FAILED');
        await fetch(`https://github.com/${policy.repository}/releases/download/${expected.tag}/${expected.packageName}`,
            path.join(directory, 'public-package'), expected.packageSize, { size: expected.packageSize, sha256: expected.packageSha256 });
    }
}

export function releaseBody(previous, { record, manager, status, sequence, review }) {
    const start = '<!-- community-publication-state:start -->', end = '<!-- community-publication-state:end -->';
    const section = `${start}\nState: ${status}\nCurrent maintainer: ${manager.publisherId} (${manager.accountType} ${manager.accountId})\n`
        + `Original publisher: ${record.owner.publisherId} (${record.owner.accountType} ${record.owner.accountId})\n`
        + `Publisher profile at review: https://github.com/${review.ownerLoginSnapshot}\nSource commit: ${record.sourceCommit}\n`
        + `Package SHA-256: ${record.package.sha256}\nReview SHA-256: ${record.reviewRef.sha256}\nGeneration: ${sequence}\n${end}`;
    const body = previous ?? '';
    const a = body.indexOf(start), b = body.indexOf(end);
    if ((a >= 0) !== (b >= 0) || a > b || a >= 0 && (body.indexOf(start, a + start.length) >= 0 || body.indexOf(end, b + end.length) >= 0)) throw new Error('RELEASE_STATE_SECTION_INVALID');
    const result = a < 0 ? `${body}\n\n${section}` : body.slice(0, a) + section + body.slice(b + end.length);
    if (Buffer.byteLength(result, 'utf8') > 65536) throw new Error('RELEASE_BODY_LIMIT');
    return result;
}

export async function finalizeReleases(context, sdk, { call = api, readGit, download = downloadCandidate, verify, write = true } = {}) {
    const state = stateReader(sdk, context.current, call);
    const bytes = state.raw('generated/current.json');
    if (!bytes) return { applied: false };
    const current = JSON.parse(bytes.toString('utf8'));
    for (const ref of [current.descriptor, current.directory, current.catalog]) state.reference(ref);
    // 只以已进入主线的不可变结果为完成证据；未合并 Draft 不参与状态投影。
    const pointers = [...state.tree.keys()].filter(file => /^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file));
    const receipts = [];
    for (const file of pointers) receipts.push(await readReceipt(sdk, JSON.parse(state.raw(file).toString('utf8')), context.current, { call, readGit, download, ...(verify ? { verify } : {}) }));
    const revocations = JSON.parse(state.reference(current.revocations).toString('utf8'));
    const releases = list(`${prefix}/releases`, null, call);
    const versions = [...state.tree.keys()].filter(file => /^published\/[^/]+\/[^/]+\.json$/u.test(file));
    let pending = false;
    for (const file of versions) {
        const record = state.read(file, 'PUBLISHED').value;
        const matches = releases.filter(release => release.tag_name === formalTag(record));
        const original = receipts.flatMap(receipt => receipt.releases).filter(release => release.tag === formalTag(record));
        if (matches.length !== 1 || original.length !== 1 || id(matches[0].id) !== id(original[0].id) || matches[0].draft
            || tagCommit(formalTag(record), call) !== original[0].targetCommit) throw new Error('PUBLICATION_RELEASE_CHANGED');
        const release = matches[0];
        const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
        for (const asset of original[0].originalAssets) {
            const matches = assets.filter(row => row.name === asset.name);
            if (matches.length !== 1 || !isDeepStrictEqual(assetIdentity(matches[0]), asset)) throw new Error('PUBLICATION_ASSET_CHANGED');
        }
        const expected = assets.filter(asset => asset.name === packageName(record));
        if (expected.length !== 1 || expected[0].state !== 'uploaded' || expected[0].size !== record.package.expectedSize
            || expected[0].digest !== `sha256:${record.package.sha256}`) throw new Error('PUBLICATION_PACKAGE_CHANGED');
        const review = JSON.parse(state.reference(record.reviewRef).toString('utf8'));
        for (const [name, bytes] of [['review.json', state.reference(record.reviewRef)], ['community-signature.json', encoded(record.communitySignature)]]) {
            const matches = assets.filter(asset => asset.name === name);
            if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== bytes.length
                || matches[0].digest !== `sha256:${hash(bytes)}`) throw new Error('PUBLICATION_ASSET_CHANGED');
        }
        const manager = state.read(`plugin-bindings/${record.pluginId}.json`, 'BINDING').value.owner;
        const status = releaseStatus(record, revocations);
        const name = `${record.owner.publisherId} / ${record.pluginId}-v${record.version}${status === 'ACTIVE' ? '' : ` [${status}]`}`;
        const body = releaseBody(release.body, { record, manager, status, sequence: current.sequence, review });
        if (release.name !== name || release.body !== body) {
            if (!write) { pending = true; continue; }
            if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
            try { call(`${prefix}/releases/${id(release.id)}`, { method: 'PATCH', body: { name, body } }); }
            catch (error) { const actual = call(`${prefix}/releases/${id(release.id)}`); if (actual.name !== name || actual.body !== body) throw error; }
            const actual = call(`${prefix}/releases/${id(release.id)}`);
            if (actual.name !== name || actual.body !== body || actual.tag_name !== release.tag_name || actual.draft) throw new Error('RELEASE_STATUS_READBACK_FAILED');
        }
    }
    if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== context.current) throw new Error('APPLY_BASE_CHANGED');
    return { applied: !pending, sequence: current.sequence, receipts };
}
