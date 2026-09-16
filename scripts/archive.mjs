import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { api, id, list, prefix, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { candidateIdentity, candidateSlot, verifyFiles } from './candidate.mjs';
import { verifyBuildRun } from './candidate-run.mjs';
import { downloadCandidate, uploadCandidate } from './candidate-transfer.mjs';
import { checkPull } from './submission-pr.mjs';
import { pull } from './platform.mjs';

export function candidateAssets(candidate, directory) {
    const bytes = fs.readFileSync(path.join(directory, 'candidate.json'));
    return [...candidate.files, { path: 'candidate.json', size: bytes.length, sha256: hash(bytes) }].map(file => ({ ...file,
        name: file.path.startsWith('plugin.') ? `pixivdownload-plugin-${candidate.owner.publisherId}-${candidate.submission.pluginId}-${candidate.submission.version}${path.extname(file.path)}` : file.path }));
}

const draftMarker = '<!-- community-candidate:';
const draftName = candidate => `待审核 / ${candidate.owner.publisherId} / ${candidate.submission.pluginId}-v${candidate.submission.version}`;
const reservation = (candidate, manifestSha256) => ({ slot: candidateSlot(candidate), prNumber: candidate.pr.number,
    headSha: candidate.pr.head, runId: id(candidate.runId), runAttempt: candidate.runAttempt, manifestSha256 });

export function requireDraft(release, call) {
    const actual = call(`${prefix}/releases/${id(release.id)}`);
    if (!actual.draft || actual.published_at !== null || actual.tag_name !== release.tag_name
        || actual.body !== release.body) throw new Error('CANDIDATE_RELEASE_CHANGED');
}

export async function candidateReservation(release, assets, workspace, download = downloadCandidate) {
    const matches = (release.body ?? '').split('\n').filter(line => line.startsWith(draftMarker));
    if (matches.length > 1) throw new Error('CANDIDATE_RELEASE_AMBIGUOUS');
    let previous;
    if (matches.length) {
        if (!matches[0].endsWith(' -->')) throw new Error('CANDIDATE_RELEASE_CHANGED');
        previous = JSON.parse(matches[0].slice(draftMarker.length, -4));
    } else {
        // 旧归档的 PR/head tag 保留读取兼容；升级槽位时先核对原清单的发布身份。
        const manifest = assets.find(asset => asset.name === 'candidate.json');
        if (!manifest || manifest.state !== 'uploaded' || !Number.isSafeInteger(manifest.size) || manifest.size < 1
            || manifest.size > API_BYTES || !/^sha256:[a-f0-9]{64}$/u.test(manifest.digest)) throw new Error('CANDIDATE_ASSET_MISSING');
        const file = path.join(workspace, `previous-${crypto.randomUUID()}.json`);
        await download(`${prefix}/releases/assets/${id(manifest.id)}`, file, API_BYTES,
            { size: manifest.size, sha256: manifest.digest.slice(7) });
        const original = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (candidateIdentity(original) !== release.tag_name) throw new Error('CANDIDATE_TAG_CHANGED');
        previous = reservation(original, manifest.digest.slice(7));
    }
    if (!/^candidate\/[a-f0-9]{64}$/u.test(previous.slot)
        || matches.length && previous.slot !== release.tag_name
        || !Number.isSafeInteger(previous.prNumber) || previous.prNumber < 1
        || !/^[a-f0-9]{40}$/u.test(previous.headSha) || !/^[a-f0-9]{64}$/u.test(previous.manifestSha256)
        || !Number.isSafeInteger(previous.runAttempt) || previous.runAttempt < 1) throw new Error('CANDIDATE_RELEASE_CHANGED');
    id(previous.runId);
    return previous;
}

export async function prepareCandidateDraft(sdk, candidate, directory, current, { call = api, download = downloadCandidate } = {}) {
    const tag = candidateSlot(candidate), expected = candidateAssets(candidate, directory);
    const next = reservation(candidate, expected.find(file => file.path === 'candidate.json').sha256);
    const releases = list(`${prefix}/releases`, null, call);
    if (releases.some(release => release.tag_name === `${candidate.owner.publisherId}/${candidate.submission.pluginId}-v${candidate.submission.version}`)) {
        throw new Error('CANDIDATE_ALREADY_PUBLISHED');
    }
    const slots = releases.filter(release => release.tag_name === tag);
    if (slots.length > 1) throw new Error('CANDIDATE_RELEASE_AMBIGUOUS');
    let release = slots[0];
    if (!release) {
        const legacy = releases.filter(release => release.draft && release.name === draftName(candidate)
            && /^candidate\/pr-[1-9][0-9]*\/[a-f0-9]{40}\/[a-f0-9]{64}$/u.test(release.tag_name));
        for (const row of legacy) {
            const number = Number(row.tag_name.split('/')[1].slice(3));
            const pr = pull(number, call);
            if (pr.merged || pr.state === 'open' && number !== candidate.pr.number) throw new Error('CANDIDATE_SLOT_IN_USE');
        }
        release = legacy.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    }
    let assets = [], replace = true;
    if (release) {
        if (!release.draft || release.published_at !== null) throw new Error('CANDIDATE_ALREADY_PUBLISHED');
        assets = list(`${prefix}/releases/${id(release.id)}/assets`, null, call);
        if (new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error('CANDIDATE_ASSETS_CONFLICT');
        const packageStem = `pixivdownload-plugin-${candidate.owner.publisherId}-${candidate.submission.pluginId}-${candidate.submission.version}`;
        const allowed = new Set(['candidate.json', 'archive-attestation.json', 'source.zip', 'review-evidence.zip', `${packageStem}.jar`, `${packageStem}.zip`]);
        if (assets.some(asset => !allowed.has(asset.name))) throw new Error('CANDIDATE_ASSETS_CONFLICT');
        const previous = await candidateReservation(release, assets, sdk.workspace, download);
        if (previous.slot !== candidateSlot(candidate)) throw new Error('CANDIDATE_RELEASE_CHANGED');
        const pr = pull(previous.prNumber, call);
        if (pr.merged || previous.prNumber !== next.prNumber && pr.state !== 'closed') throw new Error('CANDIDATE_SLOT_IN_USE');
        if (previous.prNumber === next.prNumber && (BigInt(previous.runId) > BigInt(next.runId)
            || previous.runId === next.runId && previous.runAttempt > next.runAttempt)) throw new Error('CANDIDATE_RUN_SUPERSEDED');
        if (previous.runId === next.runId && previous.runAttempt === next.runAttempt
            && previous.manifestSha256 !== next.manifestSha256) throw new Error('CANDIDATE_ASSET_CONFLICT');
        replace = previous.manifestSha256 !== next.manifestSha256 || !assets.some(asset => asset.name === 'archive-attestation.json');
        if (replace) {
            // 先撤掉旧证明；任何中断都只能留下待归档状态，不能沿用旧审核证明。
            for (const asset of assets.filter(asset => asset.name === 'archive-attestation.json')) {
                requireDraft(release, call);
                call(`${prefix}/releases/assets/${id(asset.id)}`, { method: 'DELETE' });
            }
            assets = assets.filter(asset => asset.name !== 'archive-attestation.json');
        }
    }
    const body = `Pending review. This draft does not grant approval or catalog admission.\n\n`
        + `Publisher: ${candidate.owner.publisherId}; GitHub ${candidate.owner.accountType} ID ${candidate.owner.accountId}.\n`
        + `PR #${candidate.pr.number}; head ${candidate.pr.head}; input SHA-256 ${candidate.inputSha256}.\n`
        + `Source commit: ${candidate.submission.source.commit}. Reports and exact evidence are in review-evidence.zip.\n`
        + `${draftMarker}${JSON.stringify(next)} -->`;
    const metadata = { tag_name: tag, target_commitish: current, draft: true, prerelease: false,
        make_latest: 'false', name: draftName(candidate), body };
    if (!release) release = call(`${prefix}/releases`, { method: 'POST', body: metadata });
    else if (release.tag_name !== tag || release.body !== body || release.target_commitish !== current) {
        requireDraft(release, call);
        release = call(`${prefix}/releases/${id(release.id)}`, { method: 'PATCH', body: metadata });
    }
    return { release, assets, expected, replace, tag };
}

export async function archiveCandidate(sdk, candidate, directory, current, { call = api, readGit,
    download = downloadCandidate, upload = uploadCandidate, check = checkPull } = {}) {
    candidateIdentity(candidate);
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
    const { release, assets, expected, replace, tag } = await prepareCandidateDraft(sdk, candidate, directory, current, { call, download });
    id(release.id);
    for (const asset of assets.filter(asset => asset.name !== 'archive-attestation.json' && !expected.some(file => file.name === asset.name))) {
        if (!replace) throw new Error('CANDIDATE_ASSETS_CONFLICT');
        requireDraft(release, call);
        call(`${prefix}/releases/assets/${id(asset.id)}`, { method: 'DELETE' });
    }
    for (const file of expected) {
        let asset = assets.find(value => value.name === file.name);
        if (asset && (asset.state !== 'uploaded' || asset.size !== file.size || asset.digest !== `sha256:${file.sha256}`)) {
            if (!replace) throw new Error('CANDIDATE_ASSET_CONFLICT');
            requireDraft(release, call);
            call(`${prefix}/releases/assets/${id(asset.id)}`, { method: 'DELETE' });
            asset = null;
        }
        if (!asset) { requireDraft(release, call); asset = upload(release.id, path.join(directory, file.path), file.name); }
        if (asset.name !== file.name || asset.state !== 'uploaded' || asset.size !== file.size
            || asset.digest !== `sha256:${file.sha256}`) throw new Error('CANDIDATE_ASSET_CONFLICT');
        await download(`${prefix}/releases/assets/${id(asset.id)}`, path.join(sdk.workspace, `asset-${crypto.randomUUID()}`), file.size, file);
    }
    const after = call(`${prefix}/releases/${release.id}`);
    if (!after.draft || after.published_at !== null || after.tag_name !== tag) throw new Error('CANDIDATE_RELEASE_CHANGED');
    verifyBuildRun(candidate, current, call, readGit);
    return { releaseId: id(release.id), url: after.html_url, tag, state: 'PENDING_REVIEW' };
}
