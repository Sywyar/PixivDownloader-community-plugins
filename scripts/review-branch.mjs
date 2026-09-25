import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, id, policy, sha } from './github.mjs';
import { gitFailure, githubFailure } from './submission-errors.mjs';

// 固定 GitHub 公布的 Ed25519 主机密钥；不得从当前连接自签收主机身份。
const knownHost = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n';

export function branchFailure(error, phase, transport) {
    if (error.message === 'REVIEW_BRANCH_SSH_KEY_REQUIRED') return error;
    const failure = transport === 'ssh' ? gitFailure({ ...error, stderr: String(error.stderr ?? '') + '\n' + String(error.stdout ?? '') },
        phase === 'push' ? 'push' : phase === 'fetch' ? 'fetch' : 'local') : githubFailure(error);
    const reason = /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(String(error.stderr ?? ''))
        ? 'SSH_HOST_KEY_REJECTED' : /Load key .*:|invalid format|error in libcrypto/iu.test(String(error.stderr ?? ''))
            ? 'SSH_KEY_INVALID' : failure.message;
    const diagnostic = { transport, phase, reason,
        ...(failure.status ? { status: failure.status } : {}),
        ...(Number.isInteger(failure.exitCode) && failure.exitCode >= 0 && failure.exitCode <= 255 ? { exitCode: failure.exitCode } : {}) };
    return Object.assign(new Error('REVIEW_BRANCH_WRITE_FAILED'), { diagnostic });
}

// 只写入经调用方验证的数据对象；既不检出投稿树，也不执行其中的配置、过滤器或 hooks。
export function writeReviewBranch(pr, { base, parents, writes, entries = [], message, identity, unchanged }, call,
    { execute = execFileSync, privateKey = process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY } = {}) {
    const name = pr.head.repo.full_name, ref = 'refs/heads/' + pr.head.ref;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('GITHUB_TARGET_MISMATCH');
    sha(base); parents.forEach(sha);
    if (!parents.includes(sha(pr.head.sha))) throw new Error('REVIEW_PARENT_CHANGED');
    for (const [file, bytes] of writes) {
        if (!Buffer.isBuffer(bytes) || bytes.length > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
        if (typeof file !== 'string' || /[\x00-\x1f\\]/u.test(file) || file.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) throw new Error('APPLY_WRITE_FORBIDDEN');
    }
    const branch = () => sha(call(`repos/${name}/git/ref/heads/${pr.head.ref}`).object.sha);
    let phase = 'blobs', commit, directory;
    const fork = id(pr.head.repo.id) !== policy.repositoryId;
    try {
        if (!fork) {
            const tree = [...entries];
            for (const [file, bytes] of writes) {
                const blob = call(`repos/${name}/git/blobs`, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
                tree.push({ path: file, mode: '100644', type: 'blob', sha: sha(blob.sha) });
            }
            phase = 'tree';
            const parent = call(`repos/${name}/git/commits/${base}`);
            const created = call(`repos/${name}/git/trees`, { method: 'POST', body: { base_tree: sha(parent.tree.sha), tree } });
            phase = 'commit';
            commit = sha(call(`repos/${name}/git/commits`, { method: 'POST', body: { message, tree: sha(created.sha), parents,
                ...(identity ? { author: identity, committer: identity } : {}) } }).sha);
            unchanged();
            phase = 'push';
            try { call(`repos/${name}/git/refs/heads/${pr.head.ref}`, { method: 'PATCH', body: { sha: commit, force: false } }); }
            catch (error) { if (branch() !== commit) throw branchFailure(error, phase, 'api'); }
            return commit;
        }
        delete process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY;
        if (!privateKey) throw new Error('REVIEW_BRANCH_SSH_KEY_REQUIRED');
        if (Buffer.byteLength(privateKey, 'utf8') > 16384 || !privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')) throw new Error('REVIEW_BRANCH_SSH_KEY_INVALID');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-review-'));
        const key = path.join(directory, 'identity'), hosts = path.join(directory, 'known_hosts'), config = path.join(directory, 'ssh_config');
        fs.writeFileSync(key, privateKey.trimEnd() + '\n', { mode: 0o600, flag: 'wx' });
        fs.writeFileSync(hosts, knownHost, { flag: 'wx' });
        const quotedPath = file => '"' + file.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
        fs.writeFileSync(config, `Host github.com\n  HostName github.com\n  User git\n  IdentityFile ${quotedPath(key)}\n  IdentitiesOnly yes\n  IdentityAgent none\n  BatchMode yes\n  PasswordAuthentication no\n  StrictHostKeyChecking yes\n  HostKeyAlgorithms ssh-ed25519\n  UserKnownHostsFile ${quotedPath(hosts)}\n  GlobalKnownHostsFile ${process.platform === 'win32' ? 'NUL' : '/dev/null'}\n  ConnectTimeout 15\n`, { flag: 'wx' });
        const empty = path.join(directory, 'empty'); fs.mkdirSync(empty);
        const emptyConfig = path.join(directory, 'gitconfig'); fs.writeFileSync(emptyConfig, '', { flag: 'wx' });
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PRIVATE_KEY|SSH_KEY|^(?:GIT_|SSH_)/iu.test(key)));
        Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
            GIT_SSH_COMMAND: 'ssh -F ' + "'" + config.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'",
            GIT_AUTHOR_NAME: identity?.name ?? 'Community review', GIT_COMMITTER_NAME: identity?.name ?? 'Community review',
            GIT_AUTHOR_EMAIL: identity?.email ?? `${policy.repositoryOwnerId}+${policy.repository.split('/')[0]}@users.noreply.github.com`,
            GIT_COMMITTER_EMAIL: identity?.email ?? `${policy.repositoryOwnerId}+${policy.repository.split('/')[0]}@users.noreply.github.com`,
            ...(identity?.date ? { GIT_AUTHOR_DATE: identity.date, GIT_COMMITTER_DATE: identity.date } : {}) });
        const git = (args, input) => {
            try { return execute('git', ['-C', directory, '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', ...args],
                { env, input, encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
            catch (error) { throw branchFailure(error, phase, 'ssh'); }
        };
        phase = 'prepare';
        git(['init', '--bare', '--template=' + empty]);
        git(['check-ref-format', ref]);
        phase = 'fetch';
        const forkParents = [...new Set(parents.filter(parent => parent !== base || parent === pr.head.sha))];
        if (forkParents.length) git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', `https://github.com/${name}.git`, ...forkParents]);
        if (!forkParents.includes(base)) git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', `https://github.com/${policy.repository}.git`, base]);
        phase = 'tree';
        git(['read-tree', base]);
        for (const row of entries) git(['update-index', '--add', '--cacheinfo', row.mode, sha(row.sha), row.path]);
        for (const [file, bytes] of writes) git(['update-index', '--add', '--cacheinfo', '100644', sha(git(['hash-object', '-w', '--stdin'], bytes)), file]);
        const tree = sha(git(['write-tree']));
        phase = 'commit';
        commit = sha(git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], message));
        unchanged();
        phase = 'push';
        // 只允许快进；响应丢失只核对原 ref，不重新写入或改用 force。
        try { git(['push', '--porcelain', '--', `git@github.com:${name}.git`, `${commit}:${ref}`]); }
        catch (error) { if (branch() !== commit) throw error; }
        return commit;
    } catch (error) {
        if (error.diagnostic || /^(?:REVIEW_|PUBLICATION_|APPLY_|EMERGENCY_|PR_OR_BASE_)/u.test(error.message)) throw error;
        throw branchFailure(error, phase, fork ? 'ssh' : 'api');
    } finally {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
}
