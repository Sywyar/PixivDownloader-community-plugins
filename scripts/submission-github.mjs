import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { API_BYTES, API_TIMEOUT, id, sha, policy } from './github.mjs';
import { hash } from './sdk.mjs';

export function github(endpoint, { method = 'GET', body, pages = false } = {}) {
    if (!/^(?:user(?:\/orgs(?:\?per_page=100)?|\/memberships\/orgs\/[A-Za-z0-9-]+)?|users\/[A-Za-z0-9-]+|organizations\/[1-9][0-9]*|repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[^\s\\]*)?)$/u.test(endpoint)
        || endpoint.split('/').some(part => part === '..' || part === '.')) throw new Error('GITHUB_TARGET_MISMATCH');
    if (!['GET', 'POST'].includes(method)) throw new Error('GITHUB_METHOD_FORBIDDEN');
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
    if (pages) args.push('--paginate', '--slurp');
    if (body !== undefined) args.push('--input', '-');
    try {
        const output = execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT,
            maxBuffer: API_BYTES, input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'] });
        return output.trim() ? JSON.parse(output) : null;
    } catch (error) {
        if (error.stderr?.includes('(HTTP 404)')) throw new Error('GITHUB_NOT_FOUND');
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

export function protectedSnapshot(call = github) {
    const repository = checkedRepository(policy.repository, call);
    if (id(repository.id) !== policy.repositoryId || id(repository.owner.id) !== policy.repositoryOwnerId
        || repository.default_branch !== policy.defaultBranch) throw new Error('GITHUB_REPOSITORY_MISMATCH');
    const base = sha(call(`repos/${policy.repository}/git/ref/heads/${policy.defaultBranch}`).object.sha);
    return { repositoryId: id(repository.id), base, actor: actor(call) };
}

export function unchanged(expected, call = github) {
    const current = protectedSnapshot(call);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('IDENTITY_OR_BASE_CHANGED');
    return current;
}

export function repositoryTree(name, commit, call = github) {
    const result = call(`repos/${name}/git/trees/${sha(commit)}?recursive=1`);
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
    const blob = call(`repos/${name}/git/blobs/${sha(entry.sha)}`);
    if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size) throw new Error('GITHUB_BLOB_CHANGED');
    const bytes = Buffer.from(blob.content, 'base64');
    const objectId = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`, 'utf8')).update(bytes).digest('hex');
    if (bytes.length !== entry.size || objectId !== entry.sha) throw new Error('GITHUB_BLOB_CHANGED');
    return bytes;
}

export function stateReader(sdk, base, call = github) {
    const tree = repositoryTree(policy.repository, base, call);
    const cached = new Map();
    const documents = new Map();
    let total = 0;
    const raw = file => {
        if (!tree.has(file)) return null;
        if (!cached.has(file)) {
            const bytes = readBlob(policy.repository, tree.get(file), call);
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
            if (request.requestId !== audit.requestId || p.action !== audit.action || audit.result !== 'APPLIED') throw new Error('AUDIT_REQUEST_MISMATCH');
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
    const membership = call(`user/memberships/orgs/${organization.login}`);
    return membership.state === 'active' && id(membership.user.id) === user.id && id(membership.organization.id) === owner.accountId;
}

export const bytesReference = (file, bytes) => ({ path: file, size: bytes.length, sha256: hash(bytes) });
