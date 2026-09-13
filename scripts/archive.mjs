import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { api, id, list, prefix, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { candidateIdentity, verifyFiles } from './candidate.mjs';
import { verifyBuildRun } from './candidate-run.mjs';
import { downloadCandidate, uploadCandidate } from './candidate-transfer.mjs';
import { checkPull } from './submission-pr.mjs';

export function findCandidate(tag, call = api) {
    const releases = list(`${prefix}/releases`, null, call).filter(release => release.tag_name === tag);
    if (releases.length > 1) throw new Error('CANDIDATE_RELEASE_AMBIGUOUS');
    return releases[0] ?? null;
}

export function candidateAssets(candidate, directory) {
    const bytes = fs.readFileSync(path.join(directory, 'candidate.json'));
    return [...candidate.files, { path: 'candidate.json', size: bytes.length, sha256: hash(bytes) }].map(file => ({ ...file,
        name: file.path.startsWith('plugin.') ? `pixivdownload-plugin-${candidate.owner.publisherId}-${candidate.submission.pluginId}-${candidate.submission.version}${path.extname(file.path)}` : file.path }));
}

export async function archiveCandidate(sdk, candidate, directory, current, { call = api, readGit,
    download = downloadCandidate, upload = uploadCandidate, check = checkPull } = {}) {
    const tag = candidateIdentity(candidate);
    verifyBuildRun(candidate, current, call, readGit);
    const actual = await check(candidate.pr.number, sdk);
    if (actual.validation !== 'STATIC_VALIDATED' || actual.pr.head !== candidate.pr.head
        || actual.submissionSha256 !== candidate.submissionSha256 || !isDeepStrictEqual(actual.submission, candidate.submission)
        || !isDeepStrictEqual(actual.owner, candidate.owner) || !isDeepStrictEqual(actual.package, candidate.package)
        || !isDeepStrictEqual(actual.descriptor, candidate.descriptor)
        || actual.publisherKeyFingerprint !== candidate.publisherKeyFingerprint) throw new Error('CANDIDATE_SUBMISSION_CHANGED');
    const maximum = 2 * sdk.invoke({ command: 'limits' }).maxArchiveBytes + API_BYTES;
    verifyFiles(directory, candidate.files, maximum);
    verifyFiles(sdk.workspace, candidate.evidence, API_BYTES);
    const packaged = candidate.files.filter(file => /^plugin\.(?:jar|zip)$/u.test(file.path));
    const source = candidate.files.find(file => file.path === 'source.zip');
    if (packaged.length !== 1 || packaged[0].size !== actual.package.size || packaged[0].sha256 !== actual.package.sha256
        || source?.size !== actual.submission.source.archive.size || source?.sha256 !== actual.submission.source.archive.sha256
        || candidate.sourceRepositoryId !== actual.sourceRepositoryId
        || !fs.readFileSync(path.join(directory, packaged[0].path)).equals(fs.readFileSync(actual.packageFile))) {
        throw new Error('CANDIDATE_BUILD_BYTES_CHANGED');
    }
    let release = findCandidate(tag, call);
    if (release && (!release.draft || release.published_at !== null)) throw new Error('CANDIDATE_ALREADY_PUBLISHED');
    if (!release) release = call(`${prefix}/releases`, { method: 'POST', body: {
        tag_name: tag, target_commitish: current, draft: true, prerelease: false, make_latest: 'false',
        name: `待审核 / ${candidate.owner.publisherId} / ${candidate.submission.pluginId}-v${candidate.submission.version}`,
        body: `Pending review. This draft is an archive, not approval or catalog admission.\n\n`
            + `Publisher: ${candidate.owner.publisherId}; GitHub ${candidate.owner.accountType} ID ${candidate.owner.accountId}.\n`
            + `Display name: ${JSON.stringify(actual.publisherDisplayName)}.\n`
            + `PR #${candidate.pr.number}; head ${candidate.pr.head}; input SHA-256 ${candidate.inputSha256}.\n`
            + `Source commit: ${candidate.submission.source.commit}. Reports and exact evidence are in review-evidence.zip.`,
    } });
    id(release.id);
    const expected = candidateAssets(candidate, directory);
    const assets = list(`${prefix}/releases/${release.id}/assets`, null, call);
    if (assets.some(asset => asset.name !== 'archive-attestation.json' && !expected.some(file => file.name === asset.name))
        || new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error('CANDIDATE_ASSETS_CONFLICT');
    for (const file of expected) {
        let asset = assets.find(value => value.name === file.name);
        if (asset && (asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== `sha256:${file.sha256}`)) {
            throw new Error('CANDIDATE_ASSET_CONFLICT');
        }
        if (!asset) asset = upload(release.id, path.join(directory, file.path), file.name);
        if (asset.name !== file.name || asset.state !== 'uploaded' || asset.size !== file.size
            || asset.digest !== `sha256:${file.sha256}`) throw new Error('CANDIDATE_ASSET_CONFLICT');
        await download(`${prefix}/releases/assets/${id(asset.id)}`, path.join(sdk.workspace, `asset-${crypto.randomUUID()}`), file.size, file);
    }
    const after = call(`${prefix}/releases/${release.id}`);
    if (!after.draft || after.published_at !== null || after.tag_name !== tag) throw new Error('CANDIDATE_RELEASE_CHANGED');
    verifyBuildRun(candidate, current, call, readGit);
    return { releaseId: id(release.id), url: after.html_url, tag, state: 'PENDING_REVIEW' };
}
