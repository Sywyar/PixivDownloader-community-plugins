import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, list, prefix, policy, repository, main } from './github.mjs';
import { cleanupPath, event, execution } from './platform.mjs';
import { candidateReservation, requireDraft } from './archive.mjs';
import { draftReleases } from './archive-read.mjs';
import { cleanupOperationArchives } from './release-retention.mjs';

const missing = error => error.status === 404 || /\(HTTP 404\)/u.test(String(error.stderr ?? ''));
const assetIdentity = assets => assets.map(({ id, name, state, size, digest }) => ({ id, name, state, size, digest }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

// 只清理仍绑定已关闭请求的候选；与归档和正式发布共用 workflow 串行队列。
export async function cleanupCandidates(number, expectedHead, workspace, { call = api, download, releases } = {}) {
    id(number); sha(expectedHead);
    const requestClosed = () => {
        const pr = call(`${prefix}/pulls/${number}`);
        if (pr.number !== Number(number) || id(pr.base.repo.id) !== policy.repositoryId
            || pr.base.ref !== policy.defaultBranch || pr.user.type !== 'User') throw new Error('PR_TARGET_INVALID');
        return pr.state === 'closed' && pr.merged === false && pr.head.sha === expectedHead;
    };
    const result = { deleted: [], retained: [] };
    if (!requestClosed()) return result;
    repository(call, { publicOnly: true });
    for (const release of releases ?? draftReleases(call)) {
        if (release.draft !== true || release.published_at !== null) continue;
        const stable = /^candidate\/[a-f0-9]{64}$/u.test(release.tag_name);
        const legacy = /^candidate\/pr-([1-9][0-9]*)\/[a-f0-9]{40}\/[a-f0-9]{64}$/u.exec(release.tag_name);
        if (!stable && legacy?.[1] !== String(number)) continue;
        const endpoint = `${prefix}/releases/${id(release.id)}`;
        let assets = stable ? null : list(`${endpoint}/assets`, null, call);
        const reservation = await candidateReservation(release, assets ?? [], workspace, download);
        if (reservation.prNumber !== Number(number)) continue;
        assets ??= list(`${endpoint}/assets`, null, call);
        if (!requestClosed()) return result;
        try { requireDraft(release, call); }
        catch (error) {
            if (missing(error)) continue;
            if (error.message !== 'CANDIDATE_RELEASE_CHANGED') throw error;
            result.retained.push({ id: release.id, reason: error.message });
            continue;
        }
        if (!isDeepStrictEqual(assetIdentity(assets), assetIdentity(list(`${endpoint}/assets`, null, call)))) {
            result.retained.push({ id: release.id, reason: 'CANDIDATE_ASSETS_CHANGED' });
            continue;
        }
        if (!requestClosed()) return result;
        requireDraft(release, call);
        let failure;
        try { call(endpoint, { method: 'DELETE' }); } catch (error) { failure = error; }
        // DELETE 响应丢失时只回读，避免再次发出删除；已不存在也视为完成。
        try { call(endpoint); }
        catch (error) {
            if (!missing(error)) throw error;
            result.deleted.push(id(release.id));
            continue;
        }
        throw failure ?? new Error('CANDIDATE_CLEANUP_NOT_CONFIRMED');
    }
    return result;
}

main(import.meta.url, async () => {
    if (process.argv.length !== 2 || !['pull_request_target', 'schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) throw new Error('CLEANUP_EVENT_REQUIRED');
    const context = execution(cleanupPath);
    const trigger = event();
    if (id(trigger.repository.id) !== policy.repositoryId || process.env.GITHUB_EVENT_NAME === 'pull_request_target'
        && (trigger.action !== 'closed' || trigger.pull_request?.state !== 'closed' || trigger.pull_request.merged !== false)) throw new Error('CLEANUP_EVENT_REQUIRED');
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'community-cleanup-'));
    try {
        const result = { deleted: [], retained: [] };
        if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
            Object.assign(result, await cleanupCandidates(trigger.pull_request.number, trigger.pull_request.head.sha, workspace));
        } else {
            const releases = draftReleases();
            for (const release of releases) if (/^candidate\//u.test(release.tag_name)) {
                const assets = list(`${prefix}/releases/${id(release.id)}/assets`, null);
                const owner = await candidateReservation(release, assets, workspace);
                const pr = api(`${prefix}/pulls/${id(owner.prNumber)}`);
                const cleaned = await cleanupCandidates(pr.number, pr.head.sha, workspace, { releases: [release] });
                result.deleted.push(...cleaned.deleted); result.retained.push(...cleaned.retained);
            }
            if (releases.some(release => /^operation\//u.test(release.tag_name))) {
                const cleaned = await cleanupOperationArchives(context.current, releases, { workspace });
                result.deleted.push(...cleaned.deleted); result.retained.push(...cleaned.retained);
            }
        }
        console.log(JSON.stringify(result));
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
            `Candidate draft cleanup\n\nDeleted Release IDs: ${result.deleted.join(', ') || 'none'}\n\nRetained: ${JSON.stringify(result.retained)}\n`, 'utf8');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
