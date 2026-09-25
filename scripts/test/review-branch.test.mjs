import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReviewBranch, branchFailure } from '../review-branch.mjs';
import { policy } from '../github.mjs';

test('真实 Git 写回 fork 只快进，保留父链与原字节，拒绝并发提交且恢复响应丢失', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-branch-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org' };
    const git = (args, input) => execFileSync('git', ['-C', directory, ...args], { env, input, encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--bare']);
    const blob = git(['hash-object', '-w', '--stdin'], Buffer.from('original\r\n'));
    git(['update-index', '--add', '--cacheinfo', '100644', blob, 'original.txt']);
    const head = git(['commit-tree', git(['write-tree'])], 'Request\n');
    git(['update-ref', 'refs/heads/request', head]);
    const pr = { head: { sha: head, ref: 'request', repo: { id: '200', full_name: 'author/fork' } } };
    const value = Buffer.from('审核\r\n\0bytes'), writes = new Map([['generated/result.json', value]]);
    const call = endpoint => {
        assert.equal(endpoint, 'repos/author/fork/git/ref/heads/request');
        return { object: { sha: git(['rev-parse', 'refs/heads/request']) } };
    };
    const previous = process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY;
    t.after(() => { if (previous === undefined) delete process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY; else process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY = previous; });
    const options = { base: head, parents: [head], writes, message: 'Reviewed\n', unchanged() {} };
    let lost = true, pushCount = 0, scratch;
    const execute = (command, args, config) => {
        assert.equal(command, 'git');
        assert(!Object.keys(config.env).some(key => /TOKEN|SECRET|PRIVATE_KEY|SSH_KEY/iu.test(key)));
        assert.equal(config.env.GIT_CONFIG_NOSYSTEM, '1');
        assert.equal(config.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(config.timeout, 60000);
        scratch = args[1];
        const ssh = execFileSync('ssh', ['-G', '-T', '-F', path.join(scratch, 'ssh_config'), 'github.com'], { encoding: 'utf8', windowsHide: true });
        assert.match(ssh, /identitiesonly yes/u); assert.match(ssh, /stricthostkeychecking true/u);
        assert.match(ssh, /identityagent none/u); assert.match(ssh, /hostkeyalgorithms ssh-ed25519/u);
        assert(fs.readFileSync(path.join(scratch, 'known_hosts'), 'utf8').startsWith('github.com ssh-ed25519 '));
        const actual = args.map(arg => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always'
            : /^https:\/\/github.com\//u.test(arg) || arg.startsWith('git@github.com:') ? directory : arg);
        if (args.includes('push')) {
            pushCount++; assert(!args.some(arg => arg.startsWith('--force')));
            assert.equal(args.at(-2), 'git@github.com:author/fork.git');
        }
        const result = execFileSync(command, actual, config);
        if (args.includes('push') && lost) { lost = false; throw Object.assign(new Error('sensitive error'), { stderr: 'connection reset', status: 128 }); }
        return result;
    };
    process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only';
    const commit = writeReviewBranch(pr, options, call, { execute });
    assert.equal(pushCount, 1); assert.equal(git(['rev-parse', 'refs/heads/request']), commit);
    assert.equal(git(['rev-parse', commit + '^']), head);
    assert.deepEqual(execFileSync('git', ['-C', directory, 'show', commit + ':generated/result.json']), value);
    assert.equal(git(['rev-parse', commit + ':original.txt']), blob);
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY, undefined);
    process.env.COMMUNITY_REVIEW_BRANCH_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only';
    const competing = git(['commit-tree', git(['rev-parse', head + '^{tree}']), '-p', head], 'Concurrent author change\n');
    assert.throws(() => writeReviewBranch(pr, { ...options, unchanged() { git(['update-ref', 'refs/heads/request', competing]); } }, call, { execute }),
        error => error.message === 'REVIEW_BRANCH_WRITE_FAILED' && error.diagnostic.reason === 'GIT_REMOTE_REJECTED');
    assert.equal(git(['rev-parse', 'refs/heads/request']), competing);
    assert.equal(fs.existsSync(scratch), false);
});

test('写入诊断保留阶段和受控原因，不泄露原生输出或密钥', () => {
    for (const [text, reason] of [['Permission denied (publickey).', 'GIT_AUTH_REQUIRED'],
        ['Host key verification failed.', 'SSH_HOST_KEY_REJECTED'], ['Load key identity: invalid format', 'SSH_KEY_INVALID'],
        ['Connection timed out', 'GITHUB_TIMEOUT'], ['[rejected] non-fast-forward', 'GIT_REMOTE_REJECTED']]) {
        const error = branchFailure(Object.assign(new Error('secret'), { stderr: text + '\nsecret', status: 128 }), 'push', 'ssh');
        assert.equal(error.diagnostic.reason, reason); assert.equal(error.diagnostic.exitCode, 128);
        assert.equal(error.message, 'REVIEW_BRANCH_WRITE_FAILED'); assert(!JSON.stringify(error).includes('secret'));
    }
    const error = branchFailure({ stderr: 'gh: permission secret (HTTP 403)', status: 1 }, 'tree', 'api');
    assert.deepEqual(error.diagnostic, { transport: 'api', phase: 'tree', reason: 'GITHUB_ACCESS_DENIED', status: 403, exitCode: 1 });
    assert.throws(() => writeReviewBranch({ head: { sha: 'a'.repeat(40), ref: 'request', repo: { id: '200', full_name: 'author/fork' } } },
        { base: 'a'.repeat(40), parents: ['a'.repeat(40)], writes: new Map(), unchanged() {} }, () => {}), /REVIEW_BRANCH_SSH_KEY_REQUIRED/);
});
