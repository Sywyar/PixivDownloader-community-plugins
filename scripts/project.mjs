import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, sha } from './github.mjs';
import { observe } from './submission-progress.mjs';

export const markerName = '.pixivdownloader-plugin-project';
export const markerMissing = 'PROJECT_MARKER_MISSING';
export const git = (directory, ...args) => observe(['fetch', 'push', 'commit'].includes(args[0]) ? 'git_' + args[0] : 'checkingProject', '', () => {
    try { return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
    '-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(); }
    catch (error) {
        if (['fetch', 'push'].includes(args[0]) && !['ENOENT', 'ENOBUFS'].includes(error.code)) {
            const temporary = ['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(error.code)
                || /unexpected EOF|connection reset|connection refused|timed out|could not resolve|HTTP (?:408|500|502|503|504)/iu.test(String(error.stderr ?? ''));
            throw Object.assign(new Error('GIT_TRANSFER_FAILED'), { github: true, retryable: temporary, method: args[0].toUpperCase(), failureStep: 'git_' + args[0] });
        }
        throw error;
    }
});

// 入口预检不写文件、不执行工程脚本、不调用 GitHub；固定 SDK 随后再次完整核验。
export function preflight(directory, { allowMissing = false } = {}) {
    const cwd = fs.realpathSync(directory);
    const missing = () => {
        if (allowMissing) return { cwd, gitRoot: null, candidates: [] };
        throw new Error(markerMissing);
    };
    let ancestor = cwd;
    while (!fs.existsSync(path.join(ancestor, '.git'))) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return missing();
        ancestor = parent;
    }
    let gitRoot;
    gitRoot = fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
    const records = git(gitRoot, 'ls-files', '--stage', '-z', '--', `:(glob)**/${markerName}`).split('\0').filter(Boolean);
    const candidates = records.map(record => {
        const match = /^(100644|100755) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t(.+)$/u.exec(record);
        if (!match) throw new Error('PROJECT_MARKER_INVALID');
        const relative = path.posix.dirname(match[2]);
        const project = path.resolve(gitRoot, relative);
        const marker = path.join(project, markerName);
        if (!fs.lstatSync(marker).isFile() || fs.realpathSync(marker) !== marker) throw new Error('PROJECT_MARKER_INVALID');
        const maximum = Buffer.byteLength('pixivdownloader-plugin-project-v1', 'utf8') + 5;
        const fd = fs.openSync(marker, 'r');
        const bytes = Buffer.alloc(maximum + 1);
        let count;
        try { count = fs.readSync(fd, bytes); } finally { fs.closeSync(fd); }
        if (count > maximum || !/^(?:\ufeff)?pixivdownloader-plugin-project-v1(?:\r?\n)?$/u.test(bytes.subarray(0, count).toString('utf8'))) {
            throw new Error('PROJECT_MARKER_INVALID');
        }
        return { projectDir: relative, project };
    }).filter(item => item.project === cwd || cwd === gitRoot && item.project.startsWith(gitRoot + path.sep));
    if (!candidates.length) return missing();
    return { cwd, gitRoot, candidates };
}

export function sourceFacts(gitRoot) {
    if (git(gitRoot, 'status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('SOURCE_COMMIT_REQUIRED');
    const commit = sha(git(gitRoot, 'rev-parse', 'HEAD'));
    const remote = git(gitRoot, 'remote', 'get-url', 'origin');
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(remote);
    if (!match || match[1].split('/').some(part => ['.', '..'].includes(part))) throw new Error('SOURCE_GITHUB_REMOTE_REQUIRED');
    return { repository: `https://github.com/${match[1]}`, name: match[1], commit, remote };
}
