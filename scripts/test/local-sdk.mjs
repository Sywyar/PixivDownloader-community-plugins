import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { policy, prefix } from '../github.mjs';
import { prepareSubmission } from '../submission-sdk.mjs';
import { runWizard as wizard } from '../submit.mjs';

export { prepareSdk } from '../sdk.mjs';
export { prepareSubmission } from '../submission-sdk.mjs';

// 普通流程测试使用真实空状态文档；紧急流程测试自己提供封禁树。
export function withEmergencyState(call = endpoint => { throw new Error('UNEXPECTED_TEST_REQUEST: ' + endpoint); }) {
    const revision = '9'.repeat(40);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'community-emergency-state', repositoryId: policy.repositoryId }));
    const blob = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    return (endpoint, options) => {
        if (endpoint === `${prefix}/branches/${policy.emergencyBranch}`) return { name: policy.emergencyBranch, protected: true, commit: { sha: revision } };
        if (endpoint === `${prefix}/git/trees/${revision}?recursive=1`) return { tree: [{ path: 'state.json', sha: blob, type: 'blob', mode: '100644', size: bytes.length }] };
        if (endpoint === `${prefix}/git/blobs/${blob}`) return { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
        return call(endpoint, options);
    };
}

export const runWizard = (directory, options) => wizard(directory, { ...options, call: withEmergencyState(options.call), prepare: prepareSubmission });

export function withRepositoryFiles(call, name, revisions) {
    return (endpoint, options) => {
        for (const [revision, records] of revisions) {
            const entries = [...records].map(([file, bytes]) => {
                const sha = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
                return { path: file, sha, mode: '100644', type: 'blob', size: bytes.length };
            });
            if (endpoint === `repos/${name}/git/trees/${revision}?recursive=1`) return { tree: entries };
            for (const entry of entries) if (endpoint === `repos/${name}/git/blobs/${entry.sha}`) {
                return { sha: entry.sha, size: entry.size, encoding: 'base64', content: records.get(entry.path).toString('base64') };
            }
        }
        return call(endpoint, options);
    };
}
