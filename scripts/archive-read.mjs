import fs from 'node:fs';
import path from 'node:path';
import { api, id, list, prefix, API_BYTES } from './github.mjs';
import { candidateIdentity, checkFiles, verifyFiles } from './candidate.mjs';
import { downloadCandidate, prepareArchive } from './candidate-transfer.mjs';
import { candidateAssets } from './archive.mjs';
import { verifyArchiveProof } from './archive-proof.mjs';

export async function readArchivedCandidate(sdk, release, current, { call = api, readGit,
    download = downloadCandidate, verify = verifyArchiveProof } = {}) {
    if (!release.draft || release.published_at !== null) throw new Error('CANDIDATE_DRAFT_REQUIRED');
    const directory = fs.mkdtempSync(path.join(sdk.workspace, 'archived-'));
    const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
    if (new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error('CANDIDATE_ASSETS_CONFLICT');
    const fetch = async (name, file, maximum, expected) => {
        const asset = assets.find(asset => asset.name === name);
        if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size > maximum
            || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) throw new Error('CANDIDATE_ASSET_MISSING');
        if (expected && (expected.size !== asset.size || `sha256:${expected.sha256}` !== asset.digest)) throw new Error('CANDIDATE_ASSET_CONFLICT');
        await download(`${prefix}/releases/assets/${id(asset.id)}`, file, maximum,
            { size: asset.size, sha256: asset.digest.slice(7) });
    };
    const manifest = path.join(directory, 'candidate.json'), bundle = path.join(directory, 'archive-attestation.json');
    await fetch('candidate.json', manifest, API_BYTES);
    await fetch('archive-attestation.json', bundle, API_BYTES);
    const certificate = verify(manifest, bundle, current, readGit);
    const candidate = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (candidateIdentity(candidate) !== release.tag_name) throw new Error('CANDIDATE_TAG_CHANGED');
    const maximum = sdk.invoke({ command: 'limits' }).maxArchiveBytes;
    checkFiles(candidate.files, 2 * maximum + API_BYTES);
    const expected = candidateAssets(candidate, directory);
    if (assets.length !== expected.length + 1) throw new Error('CANDIDATE_ASSETS_CONFLICT');
    for (const file of expected.filter(file => file.path !== 'candidate.json')) {
        await fetch(file.name, path.join(directory, file.path), file.path === 'review-evidence.zip' ? API_BYTES : maximum, file);
    }
    verifyFiles(directory, candidate.files, 2 * maximum + API_BYTES);
    prepareArchive(sdk);
    sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', sdk.classpath, 'CommunityArchive', 'reports', manifest,
        path.join(directory, 'review-evidence.zip'), sdk.workspace]);
    verifyFiles(sdk.workspace, candidate.evidence, API_BYTES);
    return { candidate, directory, certificate, releaseId: id(release.id), url: release.html_url };
}

export function archivedCandidates(number, call = api) {
    return list(`${prefix}/releases`, null, call).filter(release => release.draft && release.tag_name.startsWith(`candidate/pr-${id(number)}/`))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
