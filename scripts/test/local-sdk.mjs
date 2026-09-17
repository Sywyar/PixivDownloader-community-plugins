import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { policy, prefix } from '../github.mjs';
import { submissionAdapter } from '../submission-sdk.mjs';
import { hash, prepareSdk } from '../sdk.mjs';
import { runWizard as wizard } from '../submit.mjs';

// 仅供开发回归：生产入口始终验证固定发行物，不接受本地 classpath 覆盖。
export function prepareSubmission() {
    const sdk = prepareSdk();
    const classes = process.env.COMMUNITY_TEST_SDK_CLASSES;
    if (classes) {
        if (classes.split(path.delimiter).some(directory => !fs.statSync(directory).isDirectory())) throw new Error('TEST_SDK_CLASSES_INVALID');
        // 各适配器闭包使用同一已解包目录，确保投稿、审核和执行都验证同一候选。
        for (const directory of classes.split(path.delimiter)) fs.cpSync(directory,
            path.join(sdk.workspace, 'runtime/BOOT-INF/classes'), { recursive: true });
        const resources = path.join(sdk.workspace, 'runtime/BOOT-INF/classes/community/v1');
        const manifest = fs.readFileSync(path.join(resources, 'bundle-manifest.json'));
        fs.cpSync(resources, path.join(sdk.workspace, 'contracts/community/v1'), { recursive: true });
        // 只更新隔离测试副本的合同描述；固定发行 JAR 的摘要检查仍然执行。
        const metadataFile = path.join(sdk.workspace, 'tools/community-contract.json');
        const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
        metadata.sdkVersion = JSON.parse(manifest).toolchain.sdk;
        metadata.manifestSha256 = hash(manifest);
        fs.writeFileSync(metadataFile, JSON.stringify(metadata) + '\n');
    }
    return submissionAdapter(sdk);
}

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
