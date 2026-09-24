import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { API_BYTES, API_TIMEOUT, id, sha, policy } from './github.mjs';
import { hash } from './sdk.mjs';
import { observe } from './submission-progress.mjs';
import { retryRequest } from './submission-retry.mjs';
import { githubFailure } from './submission-errors.mjs';
export { authenticationRequired } from './submission-errors.mjs';

// 传输 owner 决定可恢复性；身份、摘要、证书及本地文件错误不能被 UI 放宽。
export const recoverableRequest = error => Boolean(error.github && error.recoverable !== false || error.download && error.retryable);
export const requestDetails = error => ({
    ...(!error.tool && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
    ...(Number.isInteger(error.attempts) && error.attempts >= 0 && error.attempts <= 3 ? { attempts: error.attempts } : {}),
    ...(Number.isSafeInteger(error.totalAttempts) && error.totalAttempts >= 0 ? { totalAttempts: error.totalAttempts } : {}),
    ...(!error.tool && Number.isInteger(error.exitCode) && error.exitCode >= 0 && error.exitCode <= 255 ? { exitCode: error.exitCode } : {}),
    ...(['DNS', 'PROXY', 'PROXY_CONNECT', 'CONNECT', 'TLS', 'HEADERS', 'BODY', 'FILE'].includes(error.downloadStage) ? { stage: error.downloadStage } : {}),
});

// gh 的 HTTP 失败带有状态标记；其余输出只用于分类，绝不作为用户诊断返回。
export function githubRequest(work, options = {}) {
    let totalAttempts = 0;
    for (let round = 1; ; round++) {
        try { return githubRequestRound(work, options); }
        catch (error) {
            if ((options.method ?? 'GET') !== 'GET' || !recoverableRequest(error) || error.message === 'GITHUB_NOT_FOUND') throw error;
            error.totalAttempts = totalAttempts += error.attempts ?? 0;
            if (!retryRequest(error, round)) throw new Error('WIZARD_SAVE');
        }
    }
}

function githubRequestRound(work, { method = 'GET', timeout = API_TIMEOUT, now = Date.now,
    wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
    const deadline = now() + timeout;
    for (let attempt = 1; ; attempt++) {
        const remaining = deadline - now();
        if (remaining <= 0) throw Object.assign(new Error('GITHUB_TIMEOUT'), { github: true, retryable: true, method, attempts: attempt - 1 });
        try { return work(remaining); }
        catch (error) {
            if (['CANCELLED', 'WIZARD_SAVE'].includes(error.message)) throw error;
            const failure = Object.assign(githubFailure(error), { method, attempts: attempt });
            const delay = attempt * 1000;
            if (method !== 'GET' || !failure.retryable
                || attempt >= 3 || now() + delay >= deadline) throw failure;
            observe('retryingGithub', `${attempt + 1}/3`, () => wait(delay));
        }
    }
}

export function github(endpoint, { method = 'GET', body, pages = false } = {}) {
    if (endpoint.startsWith('orgs/') && method !== 'GET') throw new Error('GITHUB_METHOD_FORBIDDEN');
    if (!/^(?:user(?:\/[1-9][0-9]*|\/orgs(?:\?per_page=100)?|\/memberships\/orgs\/[A-Za-z0-9-]+)?|users\/[A-Za-z0-9-]+|organizations\/[1-9][0-9]*|orgs\/[A-Za-z0-9-]+\/memberships\/[A-Za-z0-9-]+|repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[^\s\\]*)?)$/u.test(endpoint)
        || endpoint.split('/').some(part => part === '..' || part === '.')) throw new Error('GITHUB_TARGET_MISMATCH');
    const withdrawal = endpoint.startsWith(`repos/${policy.repository}/pulls/`) && /^repos\/[^/]+\/[^/]+\/pulls\/[1-9][0-9]*$/u.test(endpoint)
        && body?.state === 'closed' && Object.keys(body).length === 1;
    if (!['GET', 'POST'].includes(method) && !(method === 'PATCH' && (withdrawal || /^repos\/[^/]+\/[^/]+\/releases\/[1-9][0-9]*$/u.test(endpoint)))) throw new Error('GITHUB_METHOD_FORBIDDEN');
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
    if (pages) args.push('--paginate', '--slurp');
    if (body !== undefined) args.push('--input', '-');
    try {
        const step = endpoint === 'user' ? 'readingActor' : endpoint.includes('/pulls') ? 'readingPulls'
            : endpoint.includes('/releases') ? 'readingCandidate' : endpoint.includes('/actions') ? 'readingCI'
                : endpoint.includes('/git/') ? 'readingGitObjects' : 'readingRepository';
        const output = githubRequest(timeout => observe(method === 'GET' ? step : 'writingGithub', '', () => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout,
            maxBuffer: API_BYTES, input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'] })), { method });
        try { return output.trim() ? JSON.parse(output) : null; }
        catch { throw new Error('GITHUB_RESPONSE_INVALID'); }
    } catch (error) {
        if (error.github || ['CANCELLED', 'WIZARD_SAVE', 'INPUT_SIZE_EXCEEDED', 'GITHUB_CLI_REQUIRED', 'GITHUB_RESPONSE_INVALID'].includes(error.message)) throw error;
        // 不把原生命令、认证环境或带参数的请求输出带入错误预览。
        throw new Error('GITHUB_REQUEST_FAILED');
    }
}

export function paged(endpoint, call = github) {
    const pages = call(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100`, { pages: true });
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('GITHUB_PAGINATION_INVALID');
    const rows = pages.flat();
    const keys = rows.map(row => row.id === undefined ? row.filename : id(row.id));
    if (keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) throw new Error('GITHUB_PAGINATION_DUPLICATED');
    return rows;
}

export function actor(call = github) {
    const user = call('user');
    if (user.type !== 'User' || !/^[A-Za-z0-9-]+$/u.test(user.login)) throw new Error('GITHUB_USER_REQUIRED');
    return { id: id(user.id), type: 'User', login: user.login };
}

export function checkedRepository(name, call = github) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name)) throw new Error('GITHUB_REPOSITORY_INVALID');
    const repository = call(`repos/${name}`);
    if (repository.full_name.toLowerCase() !== name.toLowerCase() || repository.private || repository.archived) throw new Error('GITHUB_REPOSITORY_MISMATCH');
    id(repository.id); id(repository.owner.id);
    return repository;
}

export function protectedSnapshot(call = github, branch = policy.defaultBranch) {
    if (![policy.defaultBranch, policy.emergencyBranch].includes(branch)) throw new Error('GITHUB_TARGET_MISMATCH');
    const currentActor = actor(call);
    const repository = checkedRepository(policy.repository, call);
    if (id(repository.id) !== policy.repositoryId || id(repository.owner.id) !== policy.repositoryOwnerId
        || repository.default_branch !== policy.defaultBranch) throw new Error('GITHUB_REPOSITORY_MISMATCH');
    const base = sha(call(`repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`).object.sha);
    if (branch === policy.defaultBranch) return { repositoryId: id(repository.id), base, actor: currentActor };
    const emergency = call(`repos/${policy.repository}/branches/${branch}`);
    if (emergency.name !== branch || emergency.protected !== true) throw new Error('EMERGENCY_BRANCH_UNPROTECTED');
    return { repositoryId: id(repository.id), base: sha(emergency.commit.sha), actor: currentActor, branch, masterBase: base };
}

export function unchanged(expected, call = github) {
    const current = protectedSnapshot(call, expected.branch);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('IDENTITY_OR_BASE_CHANGED');
    return current;
}

export function repositoryTree(name, commit, call = github) {
    const result = call(`repos/${name}/git/trees/${sha(commit)}?recursive=1`, { repositoryName: name });
    if (result.truncated || !Array.isArray(result.tree)) throw new Error('GITHUB_TREE_INCOMPLETE');
    const entries = new Map();
    for (const entry of result.tree) {
        if (entries.has(entry.path)) throw new Error('GITHUB_TREE_DUPLICATED');
        entries.set(entry.path, entry);
    }
    return entries;
}

export function readBlob(name, entry, call = github) {
    if (!entry || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob'
        || !Number.isSafeInteger(entry.size) || entry.size > API_BYTES) throw new Error('GITHUB_FILE_INVALID');
    const blob = call(`repos/${name}/git/blobs/${sha(entry.sha)}`, { repositoryName: name });
    if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size) throw new Error('GITHUB_BLOB_CHANGED');
    const bytes = Buffer.from(blob.content, 'base64');
    const objectId = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'utf8')).update(bytes).digest('hex');
    if (bytes.length !== entry.size || objectId !== entry.sha) throw new Error('GITHUB_BLOB_CHANGED');
    return bytes;
}

// 生成和验证共用同一输入树；管理状态只来自受保护主线。
export function requestTree(baseTree, headTree, files) {
    const tree = new Map(baseTree);
    for (const file of files) {
        const entry = headTree.get(file.filename);
        if (file.status !== 'added' || file.previous_filename || tree.has(file.filename)
            || !/^(?:submissions|publishers|assets|key-rotations|version-status-requests|ownership-transfers|ownership-transfer-evidence)\//u.test(file.filename)
            || entry?.type !== 'blob' || entry.mode !== '100644' || entry.sha !== file.sha) throw new Error('APPLY_INPUT_CHANGED');
        tree.set(file.filename, entry);
    }
    return tree;
}

export function stateReader(sdk, base, call = github, repositoryName = policy.repository, request) {
    const tree = repositoryTree(repositoryName, base, call);
    const cached = new Map();
    const documents = new Map();
    let total = 0;
    if (request) {
        const headTree = repositoryTree(request.pr.head.repo.full_name, request.pr.head.sha, call);
        const combined = requestTree(tree, headTree, request.files);
        for (const file of request.files) {
            const entry = combined.get(file.filename), bytes = readBlob(request.pr.head.repo.full_name, entry, call);
            total += bytes.length;
            if (total > API_BYTES) throw new Error('STATE_SIZE_EXCEEDED');
            tree.set(file.filename, entry);
            cached.set(file.filename, bytes);
        }
    }
    const raw = file => {
        if (!tree.has(file)) return null;
        if (!cached.has(file)) {
            const bytes = readBlob(repositoryName, tree.get(file), call);
            total += bytes.length;
            if (total > API_BYTES) throw new Error('STATE_SIZE_EXCEEDED');
            cached.set(file, bytes);
        }
        return cached.get(file);
    };
    const read = (file, kind) => {
        const bytes = raw(file);
        if (!bytes) return null;
        const key = `${kind}/${file}`;
        if (!documents.has(key)) documents.set(key, { ...sdk.document(kind, bytes, file), bytes, path: file });
        return documents.get(key);
    };
    const reference = ref => {
        const bytes = raw(ref.path);
        if (!bytes || bytes.length !== ref.size || hash(bytes) !== ref.sha256) throw new Error('AUDIT_REFERENCE_MISMATCH');
        return bytes;
    };
    const published = pluginId => [...tree.keys()].filter(file => file.startsWith('published/') && file.endsWith('.json'))
        .map(file => read(file, 'PUBLISHED')).filter(record => record.value.pluginId === pluginId)
        .sort((a, b) => Date.parse(b.value.publishedAt) - Date.parse(a.value.publishedAt));
    const statusHistory = (pluginId, version, packageSha256) => {
        const records = [...tree.keys()].filter(file => file.startsWith('audits/') && file.endsWith('.json'))
            .map(file => read(file, 'AUDIT').value).filter(audit => ['YANK', 'UNYANK', 'REVOKE'].includes(audit.action))
            .sort((a, b) => a.revocationSequence - b.revocationSequence);
        const seen = new Set();
        const history = [];
        for (const audit of records) {
            if (!Number.isSafeInteger(audit.revocationSequence) || seen.has(audit.revocationSequence)) throw new Error('AUDIT_SEQUENCE_INVALID');
            seen.add(audit.revocationSequence);
            const bytes = reference(audit.requestRef);
            const request = JSON.parse(bytes.toString('utf8'));
            const p = request.payload;
            const originalPath = `version-status-requests/${p.owner.accountId}/${p.pluginId}/${p.version}/${request.requestId}.json`;
            sdk.document('STATUS_REQUEST', bytes, originalPath);
            if (request.requestId !== audit.requestId || p.action !== audit.action || !['APPLIED', 'PREPARED'].includes(audit.result)) throw new Error('AUDIT_REQUEST_MISMATCH');
            if (p.pluginId !== pluginId || p.version !== version || p.packageSha256 !== packageSha256) continue;
            for (const ref of [audit.beforeRef, audit.afterRef, audit.decisionRef, ...(audit.recoveryEvidence ?? []), ...audit.relatedRecords]) reference(ref);
            history.push({ file: sdk.save(bytes), decisionSha256: audit.decisionRef.sha256 });
        }
        return history;
    };
    const currentStatus = (pluginId, version, packageSha256, request) => {
        const history = statusHistory(pluginId, version, packageSha256);
        // 预检只验证迁移是否允许；请求摘要作临时值，不生成批准或归档事实。
        if (request) history.push({ file: sdk.save(request), decisionSha256: request.requestId });
        return sdk.invoke({ command: 'status', pluginId, version, packageSha256, history });
    };
    return { tree, raw, read, reference, published, currentStatus };
}

export function eligible(owner, user, call = github) {
    if (owner.accountType === 'User') return owner.accountId === user.id;
    if (owner.accountType !== 'Organization') return false;
    const organization = call(`organizations/${id(owner.accountId)}`);
    if (id(organization.id) !== owner.accountId || organization.type !== 'Organization') return false;
    let membership;
    try { membership = call(`user/memberships/orgs/${organization.login}`); }
    catch (error) { if (error.message === 'GITHUB_NOT_FOUND' && error.status === 404) return false; throw error; }
    return membership.state === 'active' && id(membership.user.id) === user.id && id(membership.organization.id) === owner.accountId;
}

export const bytesReference = (file, bytes) => ({ path: file, size: bytes.length, sha256: hash(bytes) });
