import { isDeepStrictEqual } from 'node:util';
import { api, id, sha, prefix, policy, API_BYTES } from './github.mjs';
import { hash } from './sdk.mjs';
import { prValue } from './platform.mjs';
import { forkApi } from './apply-result.mjs';
import { readBlob, repositoryTree, stateReader } from './submission-github.mjs';
import { publisherPath } from './submission-check.mjs';
import { emergencyState } from './emergency-state.mjs';

export function emergencyPull(number, call = api) {
    const pr = call(`${prefix}/pulls/${id(number)}`);
    if (pr.number !== Number(number) || id(pr.base.repo.id) !== policy.repositoryId
        || pr.base.ref !== policy.emergencyBranch || !pr.head.repo || pr.user.type !== 'User') throw new Error('PR_TARGET_INVALID');
    return pr;
}

// 组织普通成员不能作紧急封禁；凭据不能读取管理角色时明确拒绝，不相信请求内自报权限。
export function emergencyAuthority(pr, owner, call = api) {
    const author = { id: id(pr.user.id), type: pr.user.type };
    const representations = [];
    if (owner.accountType === 'Organization') {
        let organization, membership;
        try {
            organization = call(`organizations/${id(owner.accountId)}`);
            if (id(organization.id) !== owner.accountId || organization.type !== 'Organization'
                || !/^[A-Za-z0-9-]+$/u.test(organization.login) || !/^[A-Za-z0-9-]+$/u.test(pr.user.login)) throw new Error('ORG_IDENTITY_INVALID');
            membership = call(`orgs/${organization.login}/memberships/${pr.user.login}`);
        } catch { throw new Error('EMERGENCY_ORG_ADMIN_UNVERIFIED'); }
        if (membership.state !== 'active' || membership.role !== 'admin'
            || id(membership.user.id) !== author.id || id(membership.organization.id) !== owner.accountId) {
            throw new Error('EMERGENCY_ORG_ADMIN_REQUIRED');
        }
        const bytes = Buffer.from(JSON.stringify({ organization, membership }));
        representations.push({ subject: owner, personAccountId: author.id, evidence: {
            reference: { path: `evidence/${hash(bytes)}.json`, size: bytes.length, sha256: hash(bytes) }, bytes: bytes.toString('base64'),
        } });
    }
    return { proposalPr: prValue(pr), actualAuthor: author, representations, approval: null, authorizedReviewers: [], signedStatus: null };
}

function additions(base, tree) {
    const result = [];
    for (const file of new Set([...base.keys(), ...tree.keys()])) {
        const a = base.get(file), b = tree.get(file);
        if (a?.type === 'tree' || b?.type === 'tree') {
            if (a?.type && a.type !== 'tree' || b?.type && b.type !== 'tree') throw new Error('EMERGENCY_PATH_INVALID');
            continue;
        }
        if (a?.sha === b?.sha && a?.mode === b?.mode) continue;
        if (a || b?.type !== 'blob' || b.mode !== '100644') throw new Error('EMERGENCY_APPEND_ONLY_REQUIRED');
        result.push(file);
    }
    return result.sort();
}

// 完整树比较防止 files API 截断、隐藏删除及把源码带入数据分支。
export function checkEmergency(number, expectedHead, sdk, current, call = api) {
    const pr = emergencyPull(number, call);
    if (pr.state !== 'open' || pr.merged || pr.draft || pr.head.sha !== expectedHead) throw new Error('EMERGENCY_PR_CHANGED');
    const emergency = emergencyState(sdk, call);
    if (pr.base.sha !== emergency.revision) throw new Error('EMERGENCY_BASE_CHANGED');
    if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('APPLY_BASE_CHANGED');
    const scoped = forkApi(pr, call), name = pr.head.repo.full_name;
    const tree = repositoryTree(name, sha(pr.head.sha), scoped);
    const files = additions(emergency.tree, tree);
    const requests = files.filter(file => /^requests\/[1-9][0-9]*\/[^/]+\/[a-f0-9]{64}\.json$/u.test(file));
    if (requests.length !== 1 || files.some(file => file !== requests[0] && !/^key-blocks\/[a-f0-9]{64}\.json$/u.test(file))) {
        throw new Error('EMERGENCY_FILES_INVALID');
    }
    const requestPath = requests[0];
    const bytes = readBlob(name, tree.get(requestPath), scoped);
    const request = { ...sdk.document('EMERGENCY_REQUEST', bytes, requestPath), path: requestPath, bytes };
    let source = pr;
    if (files.length > 1) {
        const commit = scoped(`repos/${name}/git/commits/${pr.head.sha}`);
        if (commit.parents?.length !== 1) throw new Error('REVIEW_PARENT_CHANGED');
        const parent = sha(commit.parents[0].sha), parentTree = repositoryTree(name, parent, scoped);
        if (!isDeepStrictEqual(additions(emergency.tree, parentTree), [requestPath])
            || parentTree.get(requestPath)?.sha !== tree.get(requestPath)?.sha) throw new Error('REVIEW_PARENT_CHANGED');
        source = { ...pr, head: { ...pr.head, sha: parent } };
    }
    const state = stateReader(sdk, current, call), owner = request.value.payload.owner;
    const publisher = state.read(publisherPath(owner), 'PUBLISHER');
    if (!publisher) throw new Error('PUBLISHER_MISSING');
    const result = sdk.invoke({ command: 'emergency-authorize', path: requestPath, file: sdk.save(bytes),
        publisher: sdk.save(publisher.bytes), authority: emergencyAuthority(source, owner, call) });
    const writes = new Map();
    for (const block of result.blocks) {
        const file = `key-blocks/${block.key.fingerprint}.json`;
        if (emergency.readBlock(block.key.fingerprint)) continue;
        const raw = Buffer.from(JSON.stringify(block) + '\n');
        sdk.document('EMERGENCY_KEY_BLOCK', raw, file);
        writes.set(file, raw);
    }
    if (files.some(file => file !== requestPath && !writes.has(file))) throw new Error('EMERGENCY_FILES_INVALID');
    let total = bytes.length;
    for (const [file, raw] of writes) {
        if ((total += raw.length) > API_BYTES) throw new Error('EMERGENCY_SIZE_EXCEEDED');
        if (tree.has(file) && !readBlob(name, tree.get(file), scoped).equals(raw)) throw new Error('EMERGENCY_RECORD_MISMATCH');
    }
    if (files.length > 1 && writes.size + 1 !== files.length) throw new Error('EMERGENCY_FILES_INVALID');
    const unchanged = () => {
        emergency.unchanged();
        const latest = emergencyPull(number, call);
        if (latest.state !== 'open' || latest.merged || latest.draft || latest.head.sha !== expectedHead
            || latest.base.sha !== emergency.revision || id(latest.user.id) !== id(pr.user.id)
            || sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('EMERGENCY_PR_CHANGED');
    };
    unchanged();
    return { pr, source, request, writes, ready: writes.size === 0 || files.length > 1, unchanged };
}
