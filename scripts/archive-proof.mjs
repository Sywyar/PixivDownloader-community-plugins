import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, id, sha, list, policy, prefix, API_BYTES, API_TIMEOUT } from './github.mjs';
import { git } from './platform.mjs';
import { archivePath, candidateIdentity } from './candidate.mjs';
import { hash } from './sdk.mjs';
import { downloadCandidate, uploadCandidate } from './candidate-transfer.mjs';

// 只消费 gh 已验签的证书字段；工作流可自填的 predicate 不能认证执行身份。
export function archiveCertificate(results, current, readGit = git) {
    return workflowCertificate(results, current, archivePath, 'workflow_run', readGit);
}

export const publicationPath = '.github/workflows/community-review-complete.yml';
export const statusPath = '.github/workflows/community-status.yml';
export function publicationCertificate(results, current, readGit = git) {
    return workflowCertificate(results, current, publicationPath, 'workflow_dispatch', readGit);
}

function workflowCertificate(results, current, expectedPath, trigger, readGit) {
    if (!Array.isArray(results) || !results.length) throw new Error('ARCHIVE_ATTESTATION_MISSING');
    for (const result of results) {
        const certificate = result.verificationResult?.signature?.certificate;
        const workflow = `https://github.com/${policy.repository}/${expectedPath}@refs/heads/${policy.defaultBranch}`;
        if (certificate?.sourceRepositoryIdentifier !== policy.repositoryId
            || certificate.sourceRepositoryOwnerIdentifier !== policy.repositoryOwnerId
            || certificate.buildSignerURI !== workflow || certificate.buildConfigURI !== workflow
            || certificate.sourceRepositoryRef !== `refs/heads/${policy.defaultBranch}`
            || certificate.runnerEnvironment !== 'github-hosted' || certificate.buildTrigger !== trigger
            || certificate.buildSignerDigest !== certificate.sourceRepositoryDigest) continue;
        const source = sha(certificate.sourceRepositoryDigest);
        readGit(['merge-base', '--is-ancestor', source, sha(current)]);
        return certificate;
    }
    throw new Error('ARCHIVE_ATTESTATION_SOURCE_INVALID');
}

export function verifyArchiveProof(file, bundle, current, readGit = git, execute = execFileSync) {
    return verifyProof(file, bundle, current, archivePath, archiveCertificate, readGit, execute);
}

export function verifyPublicationProof(file, bundle, current, readGit = git, execute = execFileSync) {
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > API_BYTES) throw new Error('ARCHIVE_PROOF_SIZE');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.authorization === 'SIGNED_OWNER') {
        if (!['YANK', 'UNYANK', 'REVOKE'].includes(receipt.operation)) throw new Error('APPLY_RECEIPT_INVALID');
        return verifyProof(file, bundle, current, statusPath, (results, current, readGit) => {
            for (const trigger of ['workflow_run', 'workflow_dispatch']) {
                try { return workflowCertificate(results, current, statusPath, trigger, readGit); }
                catch (error) { if (error.message !== 'ARCHIVE_ATTESTATION_SOURCE_INVALID') throw error; }
            }
            throw new Error('ARCHIVE_ATTESTATION_SOURCE_INVALID');
        }, readGit, execute);
    }
    if (receipt.authorization !== undefined) throw new Error('APPLY_RECEIPT_INVALID');
    return verifyProof(file, bundle, current, publicationPath, publicationCertificate, readGit, execute);
}

function verifyProof(file, bundle, current, workflowPath, certificate, readGit, execute) {
    for (const name of [file, bundle]) {
        if (!fs.lstatSync(name).isFile() || fs.statSync(name).size > API_BYTES) throw new Error('ARCHIVE_PROOF_SIZE');
    }
    // bundle 已在本地；验证只需公共信任根，不向证书或 TUF 服务传递仓库凭据。
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PRIVATE_KEY/iu.test(key)));
    env.GH_CONFIG_DIR = fs.mkdtempSync(path.join(path.dirname(file), 'attestation-client-'));
    const output = execute('gh', ['attestation', 'verify', file, '--bundle', bundle, '--repo', policy.repository,
        '--signer-workflow', `${policy.repository}/${workflowPath}`, '--source-ref', `refs/heads/${policy.defaultBranch}`,
        '--deny-self-hosted-runners', '--format', 'json'], { encoding: 'utf8', windowsHide: true,
        env, timeout: API_TIMEOUT, maxBuffer: API_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
    return certificate(JSON.parse(output), current, readGit);
}

export async function storeArchiveProof(releaseId, file, bundle, current, { call = api,
    download = downloadCandidate, upload = uploadCandidate, verify = verifyArchiveProof } = {}) {
    verify(file, bundle, current);
    const tag = candidateIdentity(JSON.parse(fs.readFileSync(file, 'utf8')));
    const requireDraft = () => {
        const release = call(`${prefix}/releases/${id(releaseId)}`);
        if (!release.draft || release.published_at !== null || release.tag_name !== tag) throw new Error('CANDIDATE_RELEASE_CHANGED');
    };
    requireDraft();
    const assets = list(`${prefix}/releases/${id(releaseId)}/assets`, null, call).filter(asset => asset.name === 'archive-attestation.json');
    if (assets.length > 1) throw new Error('ARCHIVE_PROOF_DUPLICATED');
    if (assets.length) {
        const asset = assets[0];
        const previous = path.join(path.dirname(file), 'previous-attestation.json');
        if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1
            || asset.size > API_BYTES || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) throw new Error('ARCHIVE_PROOF_SIZE');
        await download(`${prefix}/releases/assets/${id(asset.id)}`, previous, API_BYTES,
            { size: asset.size, sha256: asset.digest.slice(7) });
        verify(file, previous, current);
        requireDraft();
        return;
    }
    const bytes = fs.readFileSync(bundle);
    const asset = upload(releaseId, bundle, 'archive-attestation.json');
    if (asset.name !== 'archive-attestation.json' || asset.state !== 'uploaded'
        || asset.size !== bytes.length || asset.digest !== `sha256:${hash(bytes)}`) throw new Error('ARCHIVE_PROOF_CHANGED');
    const readback = path.join(path.dirname(file), 'stored-attestation.json');
    await download(`${prefix}/releases/assets/${id(asset.id)}`, readback, API_BYTES,
        { size: bytes.length, sha256: hash(bytes) });
    verify(file, readback, current);
    requireDraft();
}
