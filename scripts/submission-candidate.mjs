import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { github, paged, checkedRepository } from './submission-github.mjs';
import { downloadGithubBinary, uploadGithubBinary } from './candidate-transfer.mjs';
import { id } from './github.mjs';
import { download, httpsUrl } from './download.mjs';
import { readFile } from './submission-fields.mjs';
import { hash } from './sdk.mjs';
import { setTimeout } from 'node:timers/promises';

export const candidateTag = candidate => `candidate-${candidate.pluginId}-${candidate.version}-${candidate.sourceCommit}`;
export const rollingCandidateTag = candidate => `candidate-${candidate.pluginId}`;

function checkAssetUrl(asset, repository, tag, draft) {
    const location = httpsUrl(asset.browser_download_url);
    const pathname = decodeURIComponent(location.pathname);
    const assetTag = pathname.split('/')[5];
    if (location.origin !== 'https://github.com' || location.search || location.hash
        || pathname !== `/${repository}/releases/download/${assetTag}/${asset.name}`
        || assetTag !== tag && !(draft && /^untagged-[a-f0-9]+$/u.test(assetTag))) throw new Error('CANDIDATE_ASSET_CHANGED');
}

function checkTag(call, prefix, release, commit, rolling = false) {
    try {
        const value = call(`${prefix}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
        if (rolling) throw new Error('CANDIDATE_TAG_CHANGED');
        if (value.ref !== 'refs/tags/' + release.tag_name) throw new Error('CANDIDATE_TAG_CHANGED');
    } catch (error) {
        if (release.draft && error.message === 'GITHUB_NOT_FOUND') return;
        throw error;
    }
    const value = call(`${prefix}/commits/${encodeURIComponent('refs/tags/' + release.tag_name)}`);
    if (value.sha !== commit) throw new Error('CANDIDATE_TAG_CHANGED');
}

function checkCI(call, prefix, repository, source, candidate) {
    const valid = run => run.status === 'completed' && run.event === 'push' && run.path === '.github/workflows/candidate.yml'
        && run.head_sha === source.commit && id(run.repository.id) === id(repository.id) && run.head_branch === repository.default_branch;
    const run = call(`${prefix}/actions/runs/${id(candidate.runId)}/attempts/${candidate.runAttempt}`);
    if (!valid(run) || run.run_attempt !== candidate.runAttempt) throw new Error('CANDIDATE_CI_NOT_PASSED');
    if (run.conclusion === 'success') return;
    // 归档重跑可保留旧构建附件，但旧 attempt 的构建 job 必须成功，最新整轮 CI 也必须成功。
    const latest = call(`${prefix}/actions/runs/${id(candidate.runId)}`);
    const pages = call(`${prefix}/actions/runs/${id(candidate.runId)}/attempts/${candidate.runAttempt}/jobs?per_page=100`, { pages: true });
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page.jobs))) throw new Error('GITHUB_PAGINATION_INVALID');
    const all = pages.flatMap(page => page.jobs);
    if (pages.some(page => page.total_count !== all.length) || new Set(all.map(job => id(job.id))).size !== all.length) throw new Error('GITHUB_PAGINATION_INVALID');
    const jobs = all.filter(job => job.name === `Build candidate (${hash(Buffer.from(candidate.buildProfile.projectDir)).slice(0, 16)})`);
    if (!valid(latest) || latest.conclusion !== 'success' || latest.run_attempt <= candidate.runAttempt || jobs.length !== 1
        || id(jobs[0].run_id) !== candidate.runId || jobs[0].head_sha !== source.commit
        || jobs[0].status !== 'completed' || jobs[0].conclusion !== 'success') throw new Error('CANDIDATE_CI_NOT_PASSED');
}

export async function sourceCandidate(context, source, selection, profileId, transfer = downloadGithubBinary, publicDownload = download, upload = uploadGithubBinary) {
    const { sdk, ui, call = github } = context;
    const repository = checkedRepository(source.name, call);
    const repoId = id(repository.id);
    const prefix = `repos/${source.name}`;
    const releases = paged(`${prefix}/releases`, call).filter(release => release.tag_name.startsWith('candidate-')
        && (release.tag_name.endsWith(`-${source.commit}`) || release.draft && release.target_commitish === source.commit));
    const matches = [];
    for (const release of releases) {
        if (release.target_commitish !== source.commit || !release.prerelease) throw new Error('CANDIDATE_RELEASE_CONFLICT');
        const assets = paged(`${prefix}/releases/${id(release.id)}/assets`, call);
        const metadata = assets.filter(asset => asset.name === 'source-candidate.json');
        if (release.draft && !metadata.length) continue;
        if (metadata.length !== 1 || metadata[0].size < 1 || metadata[0].size > 64 * 1024
            || !/^sha256:[a-f0-9]{64}$/u.test(metadata[0].digest) || metadata[0].state !== 'uploaded') throw new Error('CANDIDATE_METADATA_INVALID');
        const manifest = path.join(sdk.workspace, randomUUID() + '.json');
        transfer(`${prefix}/releases/assets/${id(metadata[0].id)}`, manifest, 64 * 1024,
            { size: metadata[0].size, sha256: metadata[0].digest.slice(7) });
        const candidate = sdk.invoke({ command: 'candidate', file: manifest });
        const rolling = release.tag_name === rollingCandidateTag(candidate);
        if (candidate.repositoryId !== repoId || candidate.repository.toLowerCase() !== source.name.toLowerCase()
            || candidate.sourceCommit !== source.commit || !(rolling && release.draft || release.tag_name === candidateTag(candidate))) throw new Error('CANDIDATE_SOURCE_MISMATCH');
        if (candidate.buildProfile.projectDir !== selection.projectDir || candidate.buildProfile.id !== profileId) continue;
        checkCI(call, prefix, repository, source, candidate);
        checkTag(call, prefix, release, source.commit, rolling);
        const asset = assets.filter(asset => asset.name === candidate.artifact.file);
        if (asset.length !== 1 || assets.length !== 2 || asset[0].state !== 'uploaded'
            || asset[0].size !== candidate.artifact.size || asset[0].digest !== `sha256:${candidate.artifact.sha256}`
            || !['jar', 'zip'].some(ext => candidate.artifact.file === `pixivdownload-plugin-${candidate.pluginId}-${candidate.version}.${ext}`)) throw new Error('CANDIDATE_ASSET_CHANGED');
        checkAssetUrl(asset[0], source.name, release.tag_name, release.draft);
        matches.push({ candidate, release, asset: asset[0], metadata: metadata[0], manifest });
    }
    if (!matches.length) {
        if (context.resumeCandidateId) throw new Error('CANDIDATE_NOT_FOUND');
        await recoverCandidate(context, source, repository);
        return sourceCandidate(context, source, selection, profileId, transfer, publicDownload, upload);
    }
    // 已固定的投稿优先于滚动草稿；后续 CI 不能替换同一源码的审核对象。
    const choices = matches.filter(item => item.release.tag_name === candidateTag(item.candidate)
        || !matches.some(other => other.release.tag_name === candidateTag(item.candidate)));
    const chosen = context.resumeCandidateId ? choices.find(item => id(item.release.id) === context.resumeCandidateId)
        ?? choices.find(item => item.release.tag_name === context.resumeCandidateTag)
        : choices.length === 1 ? choices[0] : await ui.select('candidate', choices, item => `${item.candidate.pluginId} ${item.candidate.version}`);
    if (!chosen) throw new Error('CANDIDATE_RELEASE_CHANGED');
    const { candidate } = chosen;
    let { release, asset } = chosen;
    const sourceRelease = { repository: source.name, id: id(release.id), tag: candidateTag(candidate) };
    // 草稿附件使用临时地址；投稿元数据固定为发布后的正式 tag 地址。
    const packageUrl = `https://github.com/${source.name}/releases/download/${encodeURIComponent(candidateTag(candidate))}/${encodeURIComponent(asset.name)}`;
    context.bindProject?.(repoId, selection.projectDir, candidate.pluginId);
    const store = context.store;
    const expected = { size: candidate.artifact.size, sha256: candidate.artifact.sha256 };
    const maximum = sdk.invoke({ command: 'limits' }).maxArchiveBytes;
    let file = store?.cached(expected.sha256, expected.size);
    if (!file) {
        file = path.join(sdk.workspace, randomUUID() + '.package');
        transfer(`${prefix}/releases/assets/${id(asset.id)}`, file, maximum, expected);
        store?.retain(file, expected.sha256, expected.size);
    }
    // 缓存按摘要命名；检查器仍需真实包扩展名来识别 JAR 与 ZIP。
    const artifact = path.join(sdk.workspace, randomUUID() + path.extname(candidate.artifact.file));
    fs.writeFileSync(artifact, readFile(file, maximum), { flag: 'wx' });
    const facts = sdk.invoke({ command: 'inspect', file: artifact });
    if (facts.pluginId !== candidate.pluginId || facts.version !== candidate.version || facts.size !== expected.size
        || facts.sha256 !== expected.sha256) throw new Error('CANDIDATE_PACKAGE_CHANGED');
    let promoted = !release.draft;
    const recheck = async () => {
        if (id(checkedRepository(source.name, call).id) !== repoId) throw new Error('CANDIDATE_SOURCE_MISMATCH');
        const current = call(`${prefix}/releases/${id(release.id)}`);
        if (current.tag_name !== release.tag_name || current.target_commitish !== source.commit || !current.prerelease
            || current.draft !== !promoted) throw new Error('CANDIDATE_RELEASE_CHANGED');
        checkTag(call, prefix, current, source.commit, current.tag_name === rollingCandidateTag(candidate));
        checkCI(call, prefix, repository, source, candidate);
        for (const original of [asset, chosen.metadata]) {
            const now = call(`${prefix}/releases/assets/${id(original.id)}`);
            if (['id', 'size', 'name', 'digest', 'updated_at', 'state'].some(field => !isDeepStrictEqual(now[field], original[field]))
                || !promoted && now.browser_download_url !== original.browser_download_url) throw new Error('CANDIDATE_ASSET_CHANGED');
            checkAssetUrl(now, source.name, release.tag_name, !promoted);
        }
        transfer(`${prefix}/releases/assets/${id(asset.id)}`, path.join(sdk.workspace, randomUUID() + '.package'), maximum, expected);
    };
    const beforeWrite = async () => {
        await recheck();
        if (release.tag_name === rollingCandidateTag(candidate)) {
            // 只复制已核对的本地字节，不修改滚动草稿，避免与 CI 覆盖争用同一 Release。
            const frozen = () => {
                const found = paged(`${prefix}/releases`, call).filter(item => item.tag_name === candidateTag(candidate));
                if (found.length > 1) throw new Error('CANDIDATE_RELEASE_CONFLICT');
                return found[0];
            };
            let target = frozen();
            if (!target) {
                checkTag(call, prefix, { draft: true, tag_name: candidateTag(candidate) }, source.commit);
                try { target = call(`${prefix}/releases`, { method: 'POST', body: { tag_name: candidateTag(candidate),
                    target_commitish: source.commit, name: `${source.name.split('/')[0]} / ${candidate.pluginId} ${candidate.version}`,
                    body: `Source candidate for ${source.commit}. Community review is required.`, draft: true, prerelease: true, make_latest: 'false' } }); }
                catch (error) { if (!error.github || !(target = frozen())) throw error; }
            }
            if (target.tag_name !== candidateTag(candidate) || target.target_commitish !== source.commit || !target.prerelease) throw new Error('CANDIDATE_RELEASE_CONFLICT');
            checkTag(call, prefix, target, source.commit);
            const assets = () => paged(`${prefix}/releases/${id(target.id)}/assets`, call);
            const files = [[candidate.artifact.file, artifact, maximum, expected], ['source-candidate.json', chosen.manifest, 64 * 1024,
                { size: chosen.metadata.size, sha256: chosen.metadata.digest.slice(7) }]];
            if (assets().some(item => !files.some(([name]) => name === item.name))) throw new Error('CANDIDATE_ASSET_CHANGED');
            const frozenAssets = [];
            for (const [name, file, limit, expectedAsset] of files) {
                const bytes = readFile(file, limit);
                if (bytes.length !== expectedAsset.size || hash(bytes) !== expectedAsset.sha256) throw new Error('CANDIDATE_PACKAGE_CHANGED');
                const find = () => {
                    const found = assets().filter(item => item.name === name);
                    if (found.length > 1) throw new Error('CANDIDATE_ASSET_CHANGED');
                    return found[0];
                };
                let existing = find();
                if (!existing) {
                    if (!target.draft) throw new Error('CANDIDATE_ASSET_CHANGED');
                    try { existing = upload(prefix, id(target.id), file, name); }
                    catch (error) { if (!error.github || !(existing = find())) throw error; }
                }
                if (existing.name !== name || existing.size !== expectedAsset.size || existing.digest !== `sha256:${expectedAsset.sha256}`
                    || existing.state !== 'uploaded') throw new Error('CANDIDATE_ASSET_CHANGED');
                checkAssetUrl(existing, source.name, target.tag_name, target.draft);
                transfer(`${prefix}/releases/assets/${id(existing.id)}`, path.join(sdk.workspace, randomUUID() + '.asset'), limit, expectedAsset);
                frozenAssets.push(existing);
            }
            release = target; [asset, chosen.metadata] = frozenAssets; promoted = !target.draft;
            await recheck();
        }
        if (!promoted) {
            let current;
            try { current = call(`${prefix}/releases/${id(release.id)}`, { method: 'PATCH', body: { draft: false, prerelease: true, make_latest: 'false' } }); }
            catch (error) {
                if (!error.github) throw error;
                current = call(`${prefix}/releases/${id(release.id)}`);
                if (current.draft) throw error;
            }
            if (current.draft || !current.prerelease || current.tag_name !== release.tag_name || current.target_commitish !== source.commit) throw new Error('CANDIDATE_PUBLICATION_FAILED');
            promoted = true;
            store?.update({ receipt: { sourceCommit: source.commit, releaseId: id(release.id), packageSha256: expected.sha256, sourcePublished: true } });
        }
        checkTag(call, prefix, { ...release, draft: false }, source.commit);
        await publicDownload(packageUrl, path.join(sdk.workspace, randomUUID() + '.package'), maximum, expected);
    };
    const fetch = async (url, destination, limit, requested) => {
        if (url !== packageUrl || promoted) return publicDownload(url, destination, limit, requested);
        if (!requested || requested.sha256 !== expected.sha256 || requested.size !== expected.size || expected.size > limit) throw new Error('CANDIDATE_PREVIEW_CHANGED');
        const bytes = readFile(artifact, maximum);
        if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Error('CANDIDATE_PACKAGE_CHANGED');
        fs.writeFileSync(destination, bytes, { flag: 'wx' });
        return { url, ...expected };
    };
    return { candidate, facts, artifact, packageUrl, recheck, beforeWrite, fetch,
        actions: release.draft ? ['PUBLISH_SOURCE_CANDIDATE'] : [], sourceRelease };
}

async function recoverCandidate(context, source, repository) {
    const { ui, call = github } = context;
    const tip = call(`repos/${source.name}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
    if (tip.object?.sha !== source.commit) throw new Error('SOURCE_CHANGED');
    const endpoint = `repos/${source.name}/actions/runs`;
    const pages = call(`${endpoint}?head_sha=${source.commit}&event=push&per_page=100`, { pages: true });
    if (!Array.isArray(pages) || !pages.length || pages.some(page => !Array.isArray(page.workflow_runs))) throw new Error('GITHUB_PAGINATION_INVALID');
    const all = pages.flatMap(page => page.workflow_runs);
    if (pages.some(page => page.total_count !== all.length) || new Set(all.map(run => id(run.id))).size !== all.length) throw new Error('GITHUB_PAGINATION_INVALID');
    const runs = all.filter(run => run.path === '.github/workflows/candidate.yml'
        && run.head_sha === source.commit && run.event === 'push' && run.head_branch === repository.default_branch
        && id(run.repository.id) === id(repository.id)).sort((a, b) => Number(b.id) - Number(a.id));
    if (!runs.length) throw new Error('CANDIDATE_NOT_FOUND');
    const run = runs[0];
    const identity = `${id(repository.id)}/${id(run.id)}`;
    context.recoveredCandidates ??= new Map();
    let recovery = context.recoveredCandidates.get(identity);
    if (recovery?.completed) throw new Error('CANDIDATE_ARCHIVE_FAILED');
    const detail = { repository: source.name, commit: source.commit, runId: id(run.id) };
    if (!recovery) {
        const rerun = run.status === 'completed';
        if (!await ui.confirm(rerun ? 'rerunCandidate' : 'waitCandidate', detail)) throw new Error('CANCELLED');
        recovery = { attempt: run.run_attempt + (rerun ? 1 : 0), deadline: Date.now() + 30 * 60_000, completed: false };
        context.recoveredCandidates.set(identity, recovery);
        // 请求或轮询中断后只继续读取同一 attempt，不重放平台写入，也不刷新等待预算。
        if (rerun) call(`${endpoint}/${id(run.id)}/rerun`, { method: 'POST' });
    }
    await ui.task('waitCandidate', async () => {
        for (;;) {
            if (ui.signal?.aborted) throw new Error('CANCELLED');
            const remaining = recovery.deadline - Date.now();
            if (remaining <= 0) throw new Error('CANDIDATE_WAIT_TIMEOUT');
            const current = call(`${endpoint}/${id(run.id)}`);
            if (current.head_sha !== source.commit || id(current.repository.id) !== id(repository.id)) throw new Error('CANDIDATE_SOURCE_MISMATCH');
            if (current.run_attempt >= recovery.attempt && current.status === 'completed') {
                recovery.completed = true;
                if (current.conclusion !== 'success') throw new Error('CANDIDATE_ARCHIVE_FAILED');
                return;
            }
            try { await setTimeout(Math.min(5000, Math.max(0, recovery.deadline - Date.now())), undefined, { signal: ui.signal }); }
            catch (error) { if (ui.signal?.aborted) throw new Error('CANCELLED'); throw error; }
        }
    });
}
