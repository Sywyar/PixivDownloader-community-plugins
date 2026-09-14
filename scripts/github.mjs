import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const policy = JSON.parse(fs.readFileSync(new URL('repository-policy.json', import.meta.url), 'utf8'));
export const prefix = `repos/${policy.repository}`;
export const API_TIMEOUT = 60_000;
export const API_BYTES = 32 * 1024 * 1024;

export function api(endpoint, { method = 'GET', body, token, pages = false, raw = false } = {}, execute = execFileSync) {
    if (!endpoint.startsWith(`${prefix}/`) && endpoint !== prefix && endpoint !== 'user') {
        throw new Error('GITHUB_TARGET_MISMATCH');
    }
    const args = ['api', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
    // 原始 job 日志只进入有界 pipe，保留控制字符供来源校验，不直接投影到终端。
    if (raw && method === 'GET' && new RegExp(`^${prefix}/actions/jobs/[1-9][0-9]*/logs$`).test(endpoint)) {
        args.push('--allow-escape-sequences');
    }
    if (pages) args.push('--paginate', '--slurp');
    if (body !== undefined) args.push('--input', '-');
    const output = execute('gh', args, {
        encoding: raw ? 'buffer' : 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'], input: body === undefined ? undefined : JSON.stringify(body),
        env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
    });
    return raw ? output : output.trim() ? JSON.parse(output) : null;
}

export function id(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('GITHUB_ID_INVALID');
    if (!/^[1-9][0-9]*$/u.test(String(value))) throw new Error('GITHUB_ID_INVALID');
    return String(value);
}

export function sha(value) {
    if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error('GITHUB_SHA_INVALID');
    return value;
}

export function list(endpoint, key, call = api) {
    const pages = call(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100`, { pages: true });
    if (!Array.isArray(pages) || !pages.length) throw new Error('GITHUB_PAGINATION_INVALID');
    const rows = pages.flatMap(page => {
        const values = key ? page[key] : page;
        if (!Array.isArray(values)) throw new Error('GITHUB_PAGINATION_INVALID');
        return values;
    });
    if (key && pages.some(page => page.total_count !== rows.length)) throw new Error('GITHUB_PAGINATION_INCOMPLETE');
    const ids = rows.filter(row => row.id !== undefined).map(row => id(row.id));
    if (new Set(ids).size !== ids.length) throw new Error('GITHUB_PAGINATION_DUPLICATED');
    return rows;
}

export function repository(call = api, { owner = false, publicOnly = false } = {}) {
    const repo = call(prefix);
    if (id(repo.id) !== policy.repositoryId || repo.full_name !== policy.repository
        || id(repo.owner.id) !== policy.repositoryOwnerId || repo.owner.type !== 'User'
        || repo.default_branch !== policy.defaultBranch || repo.archived) throw new Error('GITHUB_REPOSITORY_MISMATCH');
    if (publicOnly && repo.private) throw new Error('GITHUB_PUBLIC_REPOSITORY_REQUIRED');
    if (owner) {
        const user = call('user');
        if (id(user.id) !== policy.repositoryOwnerId || user.type !== 'User' || !repo.permissions?.admin) {
            throw new Error('GITHUB_OWNER_REQUIRED');
        }
    }
    return repo;
}

export function main(moduleUrl, run) {
    if (process.argv[1] && fileURLToPath(moduleUrl) === fs.realpathSync(process.argv[1])) {
        Promise.resolve().then(run).catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
