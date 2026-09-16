import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { id, sha, policy } from './github.mjs';
import { actor, github, checkedRepository, paged } from './submission-github.mjs';
import { forkTarget } from './submission-write.mjs';
import { git } from './project.mjs';

// Git 的删除 lease 在服务端比较旧 SHA；先查再 DELETE 无法防止确认后的并发更新。
export function deleteRequestBranch(workspace, target, readGit = git) {
    const checkout = fs.mkdtempSync(path.join(workspace, 'withdraw-'));
    readGit(checkout, 'init', '--bare');
    const ref = `refs/heads/${target.branch}`;
    readGit(checkout, 'push', '--porcelain', `--force-with-lease=${ref}:${target.head}`,
        `https://github.com/${target.repository}.git`, `:${ref}`);
}

export async function cleanupRequestBranch({ ui, snapshot, sdk, call = github, remove = deleteRequestBranch }, withdrawn) {
    let expected;
    const read = () => {
        if (!isDeepStrictEqual(actor(call), snapshot.actor)) throw new Error('SESSION_ACCOUNT_CHANGED');
        const pr = call(`repos/${policy.repository}/pulls/${id(withdrawn.number)}`);
        if (pr.state !== 'closed' || pr.merged || id(pr.user.id) !== snapshot.actor.id
            || pr.user.type !== 'User' || id(pr.base.repo.id) !== policy.repositoryId || pr.base.ref !== policy.defaultBranch
            || pr.head.sha !== withdrawn.head || pr.head.ref !== withdrawn.branch
            || !pr.head.repo || id(pr.head.repo.id) !== withdrawn.repositoryId) throw new Error('BRANCH_CLEANUP_UNSAFE');
        const fork = forkTarget(snapshot, call);
        if (fork.create || fork.id !== withdrawn.repositoryId) throw new Error('BRANCH_CLEANUP_UNSAFE');
        const repository = checkedRepository(fork.name, call);
        if (id(repository.id) !== fork.id || id(repository.owner.id) !== snapshot.actor.id) throw new Error('BRANCH_CLEANUP_UNSAFE');
        const branch = pr.head.ref;
        if (branch === repository.default_branch || branch === policy.defaultBranch
            || !/^community\/(?:first_release|update|yank|unyank|revoke|key_rotation|ownership_transfer)\/[0-9a-f]{24}(?:-after-[1-9][0-9]*)?$/u.test(branch)) {
            throw new Error('BRANCH_CLEANUP_UNSAFE');
        }
        const target = { repository: fork.name, repositoryId: fork.id, branch, head: sha(pr.head.sha) };
        if (expected && !isDeepStrictEqual(expected, target)) throw new Error('BRANCH_CLEANUP_UNSAFE');
        let remote;
        try { remote = call(`repos/${fork.name}/branches/${encodeURIComponent(branch)}`); }
        catch (error) { if (error.message === 'GITHUB_NOT_FOUND') return { target, missing: true }; throw error; }
        if (remote.commit.sha !== target.head || remote.protected !== false) throw new Error('BRANCH_CLEANUP_UNSAFE');
        const rules = call(`repos/${fork.name}/rules/branches/${encodeURIComponent(branch)}`);
        if (!Array.isArray(rules) || rules.some(rule => ['deletion', 'update'].includes(rule.type))) throw new Error('BRANCH_CLEANUP_UNSAFE');
        for (const base of new Set([policy.repository, fork.name])) {
            const pulls = paged(`repos/${base}/pulls?state=open&head=${encodeURIComponent(snapshot.actor.login + ':' + branch)}`, call);
            if (pulls.some(other => other.head.repo && id(other.head.repo.id) === fork.id && other.head.ref === branch)) throw new Error('BRANCH_CLEANUP_IN_USE');
        }
        return { target, missing: false };
    };
    for (;;) {
        try {
            const before = read();
            if (before.missing) { ui.say('branchRemoved', before.target); return 'removed'; }
            expected = before.target;
            if (!await ui.confirm('deleteRequestBranch', expected)) return 'retained';
            if (read().missing) { ui.say('branchRemoved', expected); return 'removed'; }
            let failure;
            try { remove(sdk.workspace, expected); } catch (error) { failure = error; }
            // 传输响应丢失只回读，不自动再次执行删除。
            if (read().missing) { ui.say('branchRemoved', expected); return 'removed'; }
            throw failure ?? new Error('BRANCH_CLEANUP_FAILED');
        } catch (error) {
            if (['CANCELLED', 'WIZARD_BACK', 'WIZARD_SAVE'].includes(error.message)) return 'retained';
            const code = /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : 'BRANCH_CLEANUP_FAILED';
            ui.say('branchRetained', { ...(expected ?? {}), code });
            if (!error.github) return 'retained';
            try { if (!await ui.confirm('retryBranchCleanup')) return 'retained'; }
            catch { return 'retained'; }
        }
    }
}
