import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, prefix, id } from './github.mjs';
import { root, hash } from './sdk.mjs';

// GitHub API 的重定向及认证由已有 gh 客户端处理；二进制入口只接受本仓库的数字 asset ID。
export function downloadCandidate(endpoint, file, maximum, expected) {
    if (!new RegExp(`^${prefix}/(?:actions/artifacts/[1-9][0-9]*/zip|releases/assets/[1-9][0-9]*)$`).test(endpoint)
        || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error('CANDIDATE_DOWNLOAD_INVALID');
    const bytes = execFileSync('gh', ['api', '--hostname', 'github.com', '-H', 'Accept: application/octet-stream', endpoint],
        { encoding: 'buffer', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: maximum + 1,
            stdio: ['ignore', 'pipe', 'pipe'] });
    if (bytes.length > maximum || expected && (bytes.length !== expected.size || hash(bytes) !== expected.sha256)) {
        throw new Error('CANDIDATE_DOWNLOAD_CHANGED');
    }
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { size: bytes.length, sha256: hash(bytes) };
}

export function uploadCandidate(releaseId, file, name) {
    if (!/^(?:candidate\.json|archive-attestation\.json|pixivdownload-plugin-[A-Za-z0-9._+-]+\.(?:jar|zip)|source\.zip|review-evidence\.zip)$/u.test(name)
        || !fs.lstatSync(file).isFile()) throw new Error('CANDIDATE_UPLOAD_INVALID');
    const result = execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'POST',
        '-H', 'Content-Type: application/octet-stream', `https://uploads.github.com/${prefix}/releases/${id(releaseId)}/assets?name=${encodeURIComponent(name)}`,
        '--input', file], { encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] });
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
