import { policy, prefix, sha, API_BYTES } from './github.mjs';
import { github, repositoryTree, readBlob } from './submission-github.mjs';
import { hash } from './sdk.mjs';
import { isDeepStrictEqual } from 'node:util';
import { versionState } from './submission-version-state.mjs';

export const keyFingerprint = key => hash(Buffer.from(key.publicKeySpkiBase64, 'base64'));

// 仅从受保护紧急分支读取；不存在、不可访问或损坏均不能解释为空状态。
export function emergencyState(sdk, call = github) {
    const branch = call(`${prefix}/branches/${policy.emergencyBranch}`);
    if (branch.name !== policy.emergencyBranch || branch.protected !== true) throw new Error('EMERGENCY_BRANCH_UNPROTECTED');
    const revision = sha(branch.commit.sha);
    const tree = repositoryTree(policy.repository, revision, call);
    const cached = new Map();
    let total = 0;
    const raw = file => {
        if (!tree.has(file)) return null;
        if (!cached.has(file)) {
            const bytes = readBlob(policy.repository, tree.get(file), call);
            if ((total += bytes.length) > API_BYTES) throw new Error('STATE_SIZE_EXCEEDED');
            cached.set(file, bytes);
        }
        return cached.get(file);
    };
    const marker = raw('state.json');
    if (!marker || sdk.document('EMERGENCY_STATE', marker, 'state.json').value.repositoryId !== policy.repositoryId) {
        throw new Error('EMERGENCY_STATE_INVALID');
    }
    const readBlock = fingerprint => {
        if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('EMERGENCY_FINGERPRINT_INVALID');
        const file = `key-blocks/${fingerprint}.json`;
        const bytes = raw(file);
        if (!bytes) return null;
        const block = sdk.document('EMERGENCY_KEY_BLOCK', bytes, file).value;
        const request = raw(block.requestRef.path);
        if (!request || request.length !== block.requestRef.size || hash(request) !== block.requestRef.sha256) {
            throw new Error('EMERGENCY_RECORD_MISMATCH');
        }
        const declaration = sdk.document('EMERGENCY_REQUEST', request, block.requestRef.path).value;
        if (!isDeepStrictEqual(block.owner, declaration.payload.owner)
            || block.pr.githubRepositoryId !== policy.repositoryId || block.key.fingerprint !== fingerprint
            || !declaration.payload.keys.some(key => key.keyId === block.key.keyId && key.fingerprint === fingerprint)
            || block.owner.accountType === 'User' && block.pr.authorAccountId !== block.owner.accountId) {
            throw new Error('EMERGENCY_RECORD_MISMATCH');
        }
        return { value: block, file, bytes, request };
    };
    const requireKey = key => {
        const block = readBlock(keyFingerprint(key));
        return sdk.invoke({ command: 'emergency-key', key, blocks: block ? [{
            file: sdk.save(block.bytes), path: block.file, request: sdk.save(block.request),
        }] : [] });
    };
    const unchanged = () => {
        const current = call(`${prefix}/branches/${policy.emergencyBranch}`);
        if (current.protected !== true || sha(current.commit.sha) !== revision) throw new Error('EMERGENCY_STATE_CHANGED');
    };
    return { revision, tree, raw, readBlock, requireKey, unchanged };
}

// 项目关联只是展示信息，不授予密钥或插件管理权限。
export function keyProjects(state, owner, key) {
    const plugins = new Map();
    const owns = value => value?.accountId === owner.accountId && value?.accountType === owner.accountType && value?.publisherId === owner.publisherId;
    const project = pluginId => {
        if (!plugins.has(pluginId)) {
            const currentOwner = state.read(`plugin-bindings/${pluginId}.json`, 'BINDING')?.value.owner ?? null;
            plugins.set(pluginId, { pluginId, currentOwner, relationship: owns(currentOwner) ? 'CURRENT_OWNER'
                : currentOwner ? 'OWNERSHIP_TRANSFERRED' : 'BINDING_MISSING', versions: [] });
        }
        return plugins.get(pluginId);
    };
    for (const file of state.tree.keys()) {
        if (file.startsWith('published/') && file.endsWith('.json')) {
            const record = state.read(file, 'PUBLISHED')?.value;
            if (owns(record?.owner) && record.package.signature.keyId === key.keyId) {
                project(record.pluginId).versions.push(versionState(state, { value: record }));
            }
        } else if (key.state === 'ACTIVE' && file.startsWith('plugin-bindings/') && file.endsWith('.json')) {
            const binding = state.read(file, 'BINDING')?.value;
            if (owns(binding?.owner)) project(binding.pluginId);
        }
    }
    return [...plugins.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}
