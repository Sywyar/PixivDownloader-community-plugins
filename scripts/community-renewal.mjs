import fs from 'node:fs';
import { api, id, sha, list, prefix, policy, main } from './github.mjs';
import { hash } from './sdk.mjs';
import { repositoryTree, readBlob } from './submission-github.mjs';

export const renewalPath = '.github/workflows/community-renewal.yml';
export const renewalBranch = 'chore/community/revocations-renewal';
export const renewalFile = 'renewals/revocations.json';
export const renewalWindow = 7 * 24 * 60 * 60 * 1000;
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');

export function renewalAuthor(pr) {
    return pr.user?.type === 'Bot' && String(pr.user.id) === '41898282'
        && String(pr.head.repo?.id) === policy.repositoryId && pr.head.ref === renewalBranch;
}

export function renewalRequest(read, now = Date.now()) {
    const generation = read('generated/current.json');
    if (!generation) return null;
    const current = JSON.parse(generation.toString('utf8'));
    if (!Number.isSafeInteger(current.sequence) || current.sequence < 1) throw new Error('RENEWAL_BASE_INVALID');
    const bytes = read('revocations.json');
    if (!bytes || bytes.length !== current.revocations.size || hash(bytes) !== current.revocations.sha256) throw new Error('RENEWAL_BASE_INVALID');
    const revocations = JSON.parse(bytes.toString('utf8'));
    const deadline = Date.parse(revocations.nextUpdate);
    if (!Number.isFinite(deadline) || !Number.isFinite(now)) throw new Error('RENEWAL_BASE_INVALID');
    if (deadline - now > renewalWindow) return null;
    return { schemaVersion: 1, operation: 'RENEWAL', generation: current.sequence,
        generationSha256: hash(generation), revocationsSha256: hash(bytes), nextUpdate: revocations.nextUpdate };
}

export function checkRenewal(pr, files, current, call = api) {
    if (!renewalAuthor(pr) || pr.state !== 'open' || pr.merged || pr.base.sha !== current
        || pr.base.ref !== policy.defaultBranch || String(pr.base.repo.id) !== policy.repositoryId
        || pr.changed_files !== 1 || files.length !== 1 || files[0].filename !== renewalFile
        || !['added', 'modified'].includes(files[0].status) || files[0].previous_filename) throw new Error('RENEWAL_REQUEST_INVALID');
    const base = repositoryTree(policy.repository, current, call);
    const expected = renewalRequest(file => base.has(file) ? readBlob(policy.repository, base.get(file), call) : null);
    if (!expected) throw new Error('RENEWAL_NOT_DUE');
    expected.baseSha = sha(current);
    const tree = repositoryTree(policy.repository, pr.head.sha, call);
    const entry = tree.get(renewalFile);
    if (entry?.sha !== files[0].sha || entry?.mode !== '100644') throw new Error('RENEWAL_REQUEST_INVALID');
    const bytes = readBlob(policy.repository, entry, call);
    if (!bytes.equals(encoded(expected))) throw new Error('RENEWAL_BASE_CHANGED');
    return { operation: 'RENEWAL', requestPath: renewalFile, requestSha256: hash(bytes), requestId: hash(bytes),
        pr: { number: pr.number, state: pr.state, user: { id: id(pr.user.id), type: pr.user.type },
            baseId: policy.repositoryId, baseRef: pr.base.ref, base: current, headId: policy.repositoryId, head: sha(pr.head.sha) } };
}

// 只查询专用续签分支，不枚举或更改其它开放申请。
export function createRenewal(current, read, call = api, now = Date.now()) {
    const request = renewalRequest(read, now);
    if (!request) return { status: 'NOT_DUE' };
    request.baseSha = sha(current);
    const query = `${prefix}/pulls?state=all&base=${policy.defaultBranch}&head=${policy.repository.split('/')[0]}:${renewalBranch}`;
    const pulls = () => list(query, null, call).filter(pr => pr.head.ref === renewalBranch && String(pr.head.repo?.id) === policy.repositoryId);
    const existing = pulls();
    const open = existing.filter(pr => pr.state === 'open');
    if (open.length > 1) throw new Error('RENEWAL_PR_AMBIGUOUS');
    if (open.length) {
        if (!renewalAuthor(open[0])) throw new Error('RENEWAL_PR_IDENTITY_INVALID');
        return { status: 'EXISTING', number: open[0].number, url: open[0].html_url };
    }
    const unchanged = () => {
        if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('RENEWAL_BASE_CHANGED');
    };
    const refs = call(`${prefix}/git/matching-refs/heads/${renewalBranch}`);
    if (!Array.isArray(refs)) throw new Error('RENEWAL_REF_INVALID');
    const matches = refs.filter(ref => ref.ref === 'refs/heads/' + renewalBranch);
    if (matches.length > 1) throw new Error('RENEWAL_REF_INVALID');
    const previous = matches.length ? sha(matches[0].object.sha) : null;
    const bytes = encoded(request);
    if (previous) {
        const tree = repositoryTree(policy.repository, previous, call);
        const old = tree.has(renewalFile) ? readBlob(policy.repository, tree.get(renewalFile), call) : null;
        if (old?.equals(bytes)) {
            const cancelled = existing.find(pr => pr.head.sha === previous && pr.state === 'closed' && !pr.merged);
            if (cancelled) return { status: 'CLOSED', number: cancelled.number, url: cancelled.html_url };
        } else if (existing.some(pr => !renewalAuthor(pr))) throw new Error('RENEWAL_PR_IDENTITY_INVALID');
    }
    unchanged();
    const base = call(`${prefix}/git/commits/${sha(current)}`);
    const blob = call(`${prefix}/git/blobs`, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
    const tree = call(`${prefix}/git/trees`, { method: 'POST', body: { base_tree: sha(base.tree.sha),
        tree: [{ path: renewalFile, mode: '100644', type: 'blob', sha: sha(blob.sha) }] } });
    const commit = call(`${prefix}/git/commits`, { method: 'POST', body: { tree: sha(tree.sha), parents: [previous ?? current],
        message: 'chore(community): 请求续签社区撤销清单\n\n- 固定当前整代与撤销清单摘要\n- 保留人工审核与受保护签发' } });
    unchanged();
    try {
        call(previous ? `${prefix}/git/refs/heads/${renewalBranch}` : `${prefix}/git/refs`,
            { method: previous ? 'PATCH' : 'POST', body: previous ? { sha: sha(commit.sha), force: false }
                : { ref: 'refs/heads/' + renewalBranch, sha: sha(commit.sha) } });
    } catch (error) {
        if (call(`${prefix}/git/ref/heads/${renewalBranch}`).object.sha !== commit.sha) throw error;
    }
    unchanged();
    const body = { title: 'chore(community): 续签社区撤销清单', base: policy.defaultBranch, head: renewalBranch,
        maintainer_can_modify: true, draft: false,
        body: `当前清单将在 ${request.nextUpdate} 到期。此请求固定第 ${request.generation} 代状态，不改变任何下架或撤销决定，也不重建插件。\n\n请核对摘要并批准本 PR，再对当前 head 运行 **Complete community review**。受保护签发会把新有效期、序号和签名追加到本 PR；检查通过后再合并。仅创建本 PR 不会续期或发布。\n\n若本 PR 已过时，请关闭后重新运行 **Renew community revocations**；工作流不会覆盖人工修改。` };
    let pr;
    try { pr = call(`${prefix}/pulls`, { method: 'POST', body }); }
    catch (error) {
        const recovered = pulls().filter(pr => pr.state === 'open' && pr.head.sha === commit.sha);
        if (recovered.length !== 1) throw error;
        pr = recovered[0];
    }
    if (!renewalAuthor(pr) || pr.head.sha !== commit.sha || pr.base.sha !== current || pr.state !== 'open') throw new Error('RENEWAL_PR_CHANGED');
    return { status: 'CREATED', number: pr.number, url: pr.html_url };
}

main(import.meta.url, async () => {
    if (process.argv.length !== 2) throw new Error('RENEWAL_ARGUMENTS');
    const { execution } = await import('./platform.mjs');
    const context = execution(renewalPath);
    if (!['schedule', 'workflow_dispatch'].includes(context.run.event)) throw new Error('RENEWAL_EVENT_INVALID');
    const tree = repositoryTree(policy.repository, context.current);
    const result = createRenewal(context.current, file => tree.has(file) ? readBlob(policy.repository, tree.get(file)) : null);
    if (result.number && result.status !== 'CLOSED') {
        // job token 不会触发 pull_request_target，显式唤醒精确 PR 的只读检查。
        for (const workflow of ['submission-check.yml', 'community-gate.yml']) {
            api(`${prefix}/actions/workflows/${workflow}/dispatches`, { method: 'POST',
                body: { ref: policy.defaultBranch, inputs: { prNumber: String(result.number) } } });
        }
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.url
        ? `${result.status}: [renewal PR #${result.number}](${result.url})\n`
        : 'No revocation renewal is due.\n', 'utf8');
});
