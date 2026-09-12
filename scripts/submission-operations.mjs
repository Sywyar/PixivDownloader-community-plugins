import { activeKey, publisherPath } from './submission-check.mjs';
import { eligible, github } from './submission-github.mjs';
import { id } from './github.mjs';
import { hash } from './sdk.mjs';
import { signingKey } from './submission-release.mjs';
import { signOperation, keyLocation } from './submission-signing.mjs';
import { readFile } from './submission-fields.mjs';

const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');

async function currentProof(context, publisher) {
    const { ui, projectRoot } = context;
    if (!await ui.confirm('optionalKey', { keyId: activeKey(publisher).keyId })) return null;
    const privateFile = keyLocation(await ui.ask('privateKey'), projectRoot);
    if (!await ui.confirm('keyAction', { privateFile, keyId: activeKey(publisher).keyId })) throw new Error('CANCELLED');
    return { keyId: activeKey(publisher).keyId, privateFile };
}

export async function prepareRotation(context, rotation) {
    const { ui, sdk, sign } = context;
    const { owner, existing, selectedKey } = rotation;
    const payload = { publisherId: owner.publisherId, githubAccount: { id: owner.accountId, type: owner.accountType },
        publisherRecordSha256: existing.sha256, oldKeyId: activeKey(existing.value).keyId, newKey: selectedKey.key,
        reasonCode: await ui.select('reason', ['ROUTINE_ROTATION', 'KEY_LOST', 'KEY_COMPROMISED']), explanation: await ui.ask('explanation') };
    const proofs = { newKey: { keyId: selectedKey.key.keyId, privateFile: selectedKey.privateFile } };
    const old = await currentProof(context, existing.value);
    if (old) proofs.oldKey = old;
    const request = signOperation(sdk, sign, 'ROTATION', { schemaVersion: 1, payload }, proofs);
    return { changes: new Map([[`key-rotations/${owner.accountId}/${owner.publisherId}/${request.requestId}.json`, encoded(request)]]),
        title: `feat(publisher): rotate ${owner.publisherId} signing key` };
}

async function selectBinding(context, partiesOnly = true) {
    const { state, ui, snapshot, call = github } = context;
    const cache = new Map();
    const authorized = owner => {
        const key = `${owner.accountType}/${owner.accountId}`;
        if (!cache.has(key)) cache.set(key, eligible(owner, snapshot.actor, call));
        return cache.get(key);
    };
    const bindings = [...state.tree.keys()].filter(file => /^plugin-bindings\/[^/]+\.json$/u.test(file))
        .map(file => state.read(file, 'BINDING')).filter(record => !partiesOnly || authorized(record.value.owner));
    const selected = await ui.select('plugin', bindings, record => `${record.value.pluginId} (${record.value.owner.publisherId})`);
    if (partiesOnly && selected.value.owner.accountType === 'Organization' && !await ui.confirm('representation', selected.value.owner)) throw new Error('CANCELLED');
    return selected;
}

export async function prepareStatus(context, action) {
    const { state, ui, sdk, sign, snapshot } = context;
    const binding = await selectBinding(context);
    const { owner, pluginId } = binding.value;
    const published = await ui.select('version', state.published(pluginId), record => `${record.value.version} (${record.value.package.sha256})`);
    const reasons = { YANK: ['FUNCTIONAL_DEFECT', 'COMPATIBILITY_PROBLEM', 'MAINTAINER_WITHDRAWAL', 'LICENSE_ISSUE', 'OTHER'],
        UNYANK: ['ISSUE_RESOLVED', 'YANK_IN_ERROR', 'OTHER'], REVOKE: ['MALICIOUS_CODE', 'KEY_COMPROMISE', 'CRITICAL_VULNERABILITY', 'ARTIFACT_TAMPERING', 'OTHER'] };
    const payload = { owner, requester: { id: snapshot.actor.id, type: 'User' }, pluginBindingSha256: binding.sha256, pluginId,
        version: published.value.version, packageSha256: published.value.package.sha256, action,
        reasonCode: await ui.select('reason', reasons[action]), explanation: await ui.ask('explanation') };
    if (action === 'UNYANK') payload.yankedDecisionSha256 = state.currentStatus(pluginId, payload.version, payload.packageSha256).decisionSha256;
    const publisher = state.read(publisherPath(owner), 'PUBLISHER');
    if (!publisher) throw new Error('PUBLISHER_MISSING');
    const proof = await currentProof(context, publisher.value);
    const request = signOperation(sdk, sign, 'STATUS_REQUEST', { schemaVersion: 1, payload }, proof ? { activeKey: proof } : {});
    return { changes: new Map([[`version-status-requests/${owner.accountId}/${pluginId}/${payload.version}/${request.requestId}.json`, encoded(request)]]),
        title: `chore(plugin): ${action} ${pluginId} ${payload.version}` };
}

export async function prepareTransfer(context) {
    const { state, ui, snapshot, sdk, sign, call = github } = context;
    const requests = [...state.tree.keys()].filter(file => /^ownership-transfers\/[^/]+\/[^/]+\/proposal\.json$/u.test(file))
        .map(file => state.read(file, 'TRANSFER'));
    const proposal = await ui.select('proposal', [null, ...requests], record => record ? `${record.value.payload.pluginId} (${record.value.requestId})` : ui.text('newProposal'));
    const changes = new Map();
    let request;
    if (proposal) request = proposal.value;
    else {
        const binding = await selectBinding(context, false);
        const login = await ui.ask('targetLogin');
        if (!/^[A-Za-z0-9-]+$/u.test(login)) throw new Error('GITHUB_LOGIN_INVALID');
        const account = call(`users/${login}`);
        if (!['User', 'Organization'].includes(account.type) || account.login.toLowerCase() !== login.toLowerCase()) throw new Error('TARGET_ACCOUNT_INVALID');
        const to = { accountId: id(account.id), accountType: account.type, publisherId: await ui.ask('publisher', account.login.toLowerCase()) };
        if (!eligible(binding.value.owner, snapshot.actor, call) && !eligible(to, snapshot.actor, call)) throw new Error('TRANSFER_PARTY_REQUIRED');
        const target = state.read(publisherPath(to), 'PUBLISHER');
        const selectedKey = await signingKey(context, target ? activeKey(target.value) : null);
        if (target && (selectedKey.key.keyId !== activeKey(target.value).keyId
            || selectedKey.key.publicKeySpkiBase64 !== activeKey(target.value).publicKeySpkiBase64)) throw new Error('TARGET_KEY_CHANGED');
        const payload = { pluginId: binding.value.pluginId, pluginBindingSha256: binding.sha256, from: binding.value.owner, to,
            targetPublisherRecordSha256: target?.sha256 ?? null, targetKey: target ? { keyId: selectedKey.key.keyId } : selectedKey.key,
            ...(!target ? { targetPublisherDisplayName: await ui.ask('display', account.login) } : {}),
            mode: await ui.select('mode', ['REGULAR', 'RECOVERY']), explanation: await ui.ask('explanation') };
        if (payload.mode === 'RECOVERY') {
            payload.recoveryEvidence = [];
            for (const file of (await ui.ask('evidence')).split(',').map(value => value.trim())) {
                const bytes = readFile(file);
                const relative = `ownership-transfer-evidence/${payload.pluginId}/${hash(bytes)}.bin`;
                if (state.tree.has(relative)) {
                    if (hash(state.raw(relative)) !== hash(bytes)) throw new Error('RECOVERY_EVIDENCE_MISMATCH');
                } else changes.set(relative, bytes);
                payload.recoveryEvidence.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
            }
        }
        request = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload },
            { targetKey: { keyId: selectedKey.key.keyId, privateFile: selectedKey.privateFile } });
        changes.set(`ownership-transfers/${payload.pluginId}/${request.requestId}/proposal.json`, encoded(request));
    }
    for (const role of ['FROM', 'TO']) {
        const owner = role === 'FROM' ? request.payload.from : request.payload.to;
        if (!eligible(owner, snapshot.actor, call)) continue;
        if (owner.accountType === 'Organization' && !await ui.confirm('representation', owner)) continue;
        if (!await ui.confirm('transfer', { role, proposal: request })) continue;
        changes.set(`ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/${role.toLowerCase()}/${snapshot.actor.id}.json`,
            encoded({ schemaVersion: 1, requestId: request.requestId, role }));
    }
    if (!changes.size) throw new Error('CANCELLED');
    return { changes, title: `feat(plugin): transfer ${request.payload.pluginId} ownership` };
}
