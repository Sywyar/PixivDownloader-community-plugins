import fs from 'node:fs';
import path from 'node:path';
import { api, id, sha, list, prefix, policy } from './github.mjs';
import { immutableAsset } from './apply-result.mjs';
import { downloadCandidate } from './candidate-transfer.mjs';

export const revokedPackageTag = 'archive/revoked-packages';

// 所有撤销版本共享一份技术归档；相同包按摘要复用，正式 Release 保留撤销说明。
export function archivedPackage(record, call = api) {
    const matches = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === revokedPackageTag);
    if (matches.length > 1) throw new Error('REVOKED_ARCHIVE_CONFLICT');
    const release = matches[0];
    if (!release) return null;
    if (release.draft !== true || release.published_at !== null) throw new Error('REVOKED_ARCHIVE_CONFLICT');
    const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call).filter(asset => asset.name === record.package.sha256 + '.jar');
    if (assets.length > 1) throw new Error('REVOKED_ARCHIVE_CONFLICT');
    const asset = assets[0];
    if (!asset) return null;
    if (asset.state !== 'uploaded' || asset.size !== record.package.expectedSize || asset.digest !== `sha256:${record.package.sha256}`) throw new Error('REVOKED_ARCHIVE_CONFLICT');
    return { release, asset };
}

export async function archiveRevokedPackage(current, record, releaseId, original, workspace, { call = api, download = downloadCandidate, upload } = {}) {
    const unchanged = () => {
        if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('APPLY_BASE_CHANGED');
        const release = call(`${prefix}/releases/${id(releaseId)}`);
        if (release.draft || release.tag_name !== `${record.owner.publisherId}/${record.pluginId}-v${record.version}` || release.immutable) throw new Error('REVOKED_RELEASE_CHANGED');
    };
    unchanged();
    const directory = fs.mkdtempSync(path.join(workspace, 'revoked-')), file = path.join(directory, 'package.jar');
    let archived = archivedPackage(record, call);
    if (!archived) {
        const matches = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === revokedPackageTag);
        let target = matches[0];
        if (!target) {
            try { target = call(`${prefix}/releases`, { method: 'POST', body: { tag_name: revokedPackageTag, target_commitish: current,
                name: 'Revoked package archive', body: 'Content-addressed packages retained for published review evidence.', draft: true, prerelease: true } }); }
            catch (error) {
                const actual = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === revokedPackageTag);
                if (actual.length !== 1) throw error;
                target = actual[0];
            }
        }
        if (!target.draft || target.published_at !== null) throw new Error('REVOKED_ARCHIVE_CONFLICT');
        await download(`${prefix}/releases/assets/${id(original.id)}`, file, record.package.expectedSize,
            { size: record.package.expectedSize, sha256: record.package.sha256 });
        await immutableAsset(target.id, file, record.package.sha256 + '.jar', { call, download, upload });
        archived = archivedPackage(record, call);
    } else {
        await download(`${prefix}/releases/assets/${id(archived.asset.id)}`, file, record.package.expectedSize,
            { size: record.package.expectedSize, sha256: record.package.sha256 });
    }
    if (!archived) throw new Error('REVOKED_ARCHIVE_CONFLICT');
    unchanged();
    const assets = list(`${prefix}/releases/${id(releaseId)}/assets`, null, call);
    const actual = assets.find(asset => id(asset.id) === id(original.id));
    if (!actual || ['name', 'state', 'size', 'digest'].some(key => actual[key] !== original[key])) throw new Error('PUBLICATION_ASSET_CHANGED');
    let failure;
    try { call(`${prefix}/releases/assets/${id(original.id)}`, { method: 'DELETE' }); } catch (error) { failure = error; }
    if (list(`${prefix}/releases/${id(releaseId)}/assets`, null, call).some(asset => asset.name === original.name)) {
        throw failure ?? new Error('REVOKED_PACKAGE_REMOVAL_NOT_CONFIRMED');
    }
}
