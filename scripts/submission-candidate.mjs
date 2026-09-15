import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { github, paged, checkedRepository } from './submission-github.mjs';
import { downloadGithubBinary } from './candidate-transfer.mjs';
import { id } from './github.mjs';
import { download, httpsUrl } from './download.mjs';
import { readFile } from './submission-fields.mjs';
import { hash } from './sdk.mjs';
import { setTimeout } from 'node:timers/promises';

export const candidateTag = candidate => `candidate-${candidate.pluginId}-${candidate.version}-${candidate.sourceCommit}`;

function checkAssetUrl(asset, repository, tag, draft) {
    const location = httpsUrl(asset.browser_download_url);
    const pathname = decodeURIComponent(location.pathname);
    const assetTag = pathname.split('/')[5];
    if (location.origin !== 'https://github.com' || location.search || location.hash
        || pathname !== `/${repository}/releases/download/${assetTag}/${asset.name}`
        || assetTag !== tag && !(draft && /^untagged-[a-f0-9]+$/u.test(assetTag))) throw new Error('CANDIDATE_ASSET_CHANGED');
}

function checkTag(call, prefix, release, commit) {
    try {
        const value = call(`${prefix}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
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

export async function sourceCandidate(context, source, selection, profileId, transfer = downloadGithubBinary, publicDownload = download) {
    const { sdk, ui, call = github } = context;
    const repository = checkedRepository(source.name, call);
    const repoId = id(repository.id);
    const prefix = `repos/${source.name}`;
    const releases = paged(`${prefix}/releases`, call).filter(release => release.tag_name.startsWith('candidate-')
        && release.tag_name.endsWith(`-${source.commit}`));
    const matches = [];
    for (const release of releases) {
        if (release.target_commitish !== source.commit || !release.prerelease) throw new Error('CANDIDATE_RELEASE_CONFLICT');
        const assets = paged(`${prefix}/releases/${id(release.id)}/assets`, call);
        const metadata = assets.filter(asset => asset.name === 'source-candidate.json');
        if (metadata.length !== 1 || metadata[0].size > 64 * 1024 || metadata[0].state !== 'uploaded') throw new Error('CANDIDATE_METADATA_INVALID');
        const manifest = path.join(sdk.workspace, randomUUID() + '.json');
        transfer(`${prefix}/releases/assets/${id(metadata[0].id)}`, manifest, 64 * 1024);
        const candidate = sdk.invoke({ command: 'candidate', file: manifest });
        if (candidate.repositoryId !== repoId || candidate.repository.toLowerCase() !== source.name.toLowerCase()
            || candidate.sourceCommit !== source.commit || release.tag_name !== candidateTag(candidate)) throw new Error('CANDIDATE_SOURCE_MISMATCH');
        if (candidate.buildProfile.projectDir !== selection.projectDir || candidate.buildProfile.id !== profileId) continue;
        checkCI(call, prefix, repository, source, candidate);
        checkTag(call, prefix, release, source.commit);
        const asset = assets.filter(asset => asset.name === candidate.artifact.file);
        if (asset.length !== 1 || assets.length !== 2 || asset[0].state !== 'uploaded'
            || asset[0].size !== candidate.artifact.size || asset[0].digest !== `sha256:${candidate.artifact.sha256}`
            || !['jar', 'zip'].some(ext => candidate.artifact.file === `pixivdownload-plugin-${candidate.pluginId}-${candidate.version}.${ext}`)) throw new Error('CANDIDATE_ASSET_CHANGED');
        checkAssetUrl(asset[0], source.name, candidateTag(candidate), release.draft);
        matches.push({ candidate, release, asset: asset[0], metadata: metadata[0], manifest });
    }
    if (!matches.length) {
        await recoverCandidate(context, source, repository);
        return sourceCandidate(context, source, selection, profileId, transfer, publicDownload);
    }
    const chosen = matches.length === 1 ? matches[0] : await ui.select('candidate', matches, item => `${item.candidate.pluginId} ${item.candidate.version}`);
    const { candidate, release, asset } = chosen;
    // 草稿附件使用临时地址；投稿元数据固定为发布后的正式 tag 地址。
    const packageUrl = `https://github.com/${source.name}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`;
    context.bindProject?.(repoId, selection.projectDir, candidate.pluginId);
    const store = context.store;
    const expected = { size: candidate.artifact.size, sha256: candidate.artifact.sha256 };
    const maximum = sdk.invoke({ command: 'limits' }).maxArchiveBytes;
    let file = store?.cached(expected.sha256, expected.size);
    if (!file) {
        file = path.join(sdk.workspace, candidate.artifact.file);
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
        checkTag(call, prefix, current, source.commit);
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
        actions: release.draft ? ['PUBLISH_SOURCE_CANDIDATE'] : [], sourceRelease: { repository: source.name, id: id(release.id), tag: release.tag_name } };
}

async function recoverCandidate(context, source, repository) {
    const { ui, call = github } = context;
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
    context.recoveredCandidates ??= new Set();
    if (context.recoveredCandidates.has(identity)) throw new Error('CANDIDATE_ARCHIVE_FAILED');
    let attempt = run.run_attempt;
    const detail = { repository: source.name, commit: source.commit, runId: id(run.id) };
    if (run.status === 'completed') {
        if (!await ui.confirm('rerunCandidate', detail)) throw new Error('CANCELLED');
        // 用户确认一次精确 run 的恢复；返回表单或重新核验不会重放这次平台操作。
        context.recoveredCandidates.add(identity);
        call(`${endpoint}/${id(run.id)}/rerun`, { method: 'POST' });
        attempt++;
    } else {
        if (!await ui.confirm('waitCandidate', detail)) throw new Error('CANCELLED');
        context.recoveredCandidates.add(identity);
    }
    await ui.task('waitCandidate', async () => {
        const deadline = Date.now() + 30 * 60_000;
        for (;;) {
            if (ui.signal?.aborted) throw new Error('CANCELLED');
            const current = call(`${endpoint}/${id(run.id)}`);
            if (current.head_sha !== source.commit || id(current.repository.id) !== id(repository.id)) throw new Error('CANDIDATE_SOURCE_MISMATCH');
            if (current.run_attempt >= attempt && current.status === 'completed') {
                if (current.conclusion !== 'success') throw new Error('CANDIDATE_ARCHIVE_FAILED');
                return;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('CANDIDATE_WAIT_TIMEOUT');
            try { await setTimeout(Math.min(5000, remaining), undefined, { signal: ui.signal }); }
            catch (error) { if (ui.signal?.aborted) throw new Error('CANCELLED'); throw error; }
        }
    });
}
