import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, prefix, id } from './github.mjs';
import { root, hash } from './sdk.mjs';
import { observe } from './submission-progress.mjs';
import { githubRequest } from './submission-github.mjs';

// GitHub API 的重定向及认证由已有 gh 客户端处理；二进制入口只接受本仓库的数字 asset ID。
export function downloadCandidate(endpoint, file, maximum, expected, execute = execFileSync) {
    if (!new RegExp(`^${prefix}/(?:actions/artifacts/[1-9][0-9]*/zip|releases/assets/[1-9][0-9]*)$`).test(endpoint)
        || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('CANDIDATE_DOWNLOAD_INVALID');
    return downloadGithubBinary(endpoint, file, maximum, expected, execute);
}

// 调用方先核对数字仓库身份；API 入口和重定向仍由同一个 gh 二进制下载 owner 处理。
export function downloadGithubBinary(endpoint, file, maximum, expected, execute = execFileSync) {
    if (!/^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:actions\/artifacts\/[1-9][0-9]*\/zip|releases\/assets\/[1-9][0-9]*)$/u.test(endpoint)
        || endpoint.split('/').some(part => ['.', '..'].includes(part))
        || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('CANDIDATE_DOWNLOAD_INVALID');
    const accept = endpoint.endsWith('/zip') ? 'application/vnd.github+json' : 'application/octet-stream';
    let bytes;
    try { bytes = githubRequest(timeout => observe('downloadingCandidate', '', () => execute('gh', ['api', '--hostname', 'github.com', '-H', `Accept: ${accept}`, endpoint],
        { encoding: 'buffer', windowsHide: true, timeout, maxBuffer: maximum + 1,
            stdio: ['ignore', 'pipe', 'pipe'] }))); }
    catch (error) {
        if (error.message === 'GITHUB_TIMEOUT') error.message = 'DOWNLOAD_TIMEOUT';
        if (error.github || ['CANCELLED', 'INPUT_SIZE_EXCEEDED', 'GITHUB_CLI_REQUIRED'].includes(error.message)) throw error;
        throw new Error('GITHUB_REQUEST_FAILED');
    }
    if (bytes.length > maximum || expected && (bytes.length !== expected.size || hash(bytes) !== expected.sha256)) {
        throw new Error('CANDIDATE_DOWNLOAD_CHANGED');
    }
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { size: bytes.length, sha256: hash(bytes) };
}

export function uploadCandidate(releaseId, file, name) {
    if (!/^(?:candidate\.json|archive-attestation\.json|publication(?:-attestation)?\.json|community-signature\.json|review\.json|pixivdownload-plugin-[A-Za-z0-9._+-]+\.(?:jar|zip)|source\.zip|review-evidence\.zip)$/u.test(name)
        || !fs.lstatSync(file).isFile()) throw new Error('CANDIDATE_UPLOAD_INVALID');
    return uploadGithubBinary(prefix, releaseId, file, name);
}

export function uploadGithubBinary(repository, releaseId, file, name, execute = execFileSync) {
    if (!/^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repository)
        || repository.split('/').some(part => ['.', '..'].includes(part))
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(name) || !fs.lstatSync(file).isFile()) throw new Error('CANDIDATE_UPLOAD_INVALID');
    const result = githubRequest(timeout => observe('writingGithub', '', () => execute('gh', ['api', '--hostname', 'github.com', '--method', 'POST',
        '-H', 'Content-Type: application/octet-stream', `https://uploads.github.com/${repository}/releases/${id(releaseId)}/assets?name=${encodeURIComponent(name)}`,
        '--input', file], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] })), { method: 'POST' });
    return JSON.parse(result);
}

export function unpackCandidate(sdk, file) {
    prepareArchive(sdk);
    const directory = path.join(sdk.workspace, 'candidate');
    const candidate = JSON.parse(sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', sdk.classpath, 'CommunityArchive',
        file, directory, sdk.workspace]));
    return { candidate, directory };
}

export function prepareArchive(sdk) {
    sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', sdk.classpath, '-d', path.join(sdk.workspace, 'runtime'),
        path.join(root, 'tools/CommunityArchive.java')]);
}
