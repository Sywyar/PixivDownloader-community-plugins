import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, sha } from './github.mjs';
import { observe } from './submission-progress.mjs';

export const markerName = '.pixivdownloader-plugin-project';
export const markerMissing = '未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录';
export const git = (directory, ...args) => observe(['fetch', 'push', 'commit'].includes(args[0]) ? 'git_' + args[0] : 'checkingProject', '', () => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
    '-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd());

// 入口预检不写文件、不执行工程脚本、不调用 GitHub；固定 SDK 随后再次完整核验。
export function preflight(directory) {
    const cwd = fs.realpathSync(directory);
    let gitRoot;
    try { gitRoot = fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel')); }
    catch { throw new Error(markerMissing); }
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
    if (!candidates.length) throw new Error(markerMissing);
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
