import { activeKey, publisherPath } from './submission-check.mjs';
import { eligible, github, checkedRepository } from './submission-github.mjs';
import { id } from './github.mjs';
import { hash } from './sdk.mjs';
import { signingKey } from './submission-release.mjs';
import { signOperation, keyLocation, unlockPrivateKey } from './submission-signing.mjs';
import { readFile } from './submission-fields.mjs';
import { unavailable } from './submission-navigation.mjs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { keyLabel } from './submission-emergency.mjs';
import { emergencyState, keyFingerprint } from './emergency-state.mjs';

const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');

async function currentProof(context, publisher, automatic) {
    const { ui, projectRoot } = context;
    const owner = { accountId: publisher.githubAccount.id, accountType: publisher.githubAccount.type, publisherId: publisher.publisherId };
    ui.say('keyContext', keyLabel(context, owner, activeKey(publisher)));
    const emergency = context.emergency ?? emergencyState(context.sdk, context.call ?? github);
    if (emergency.readBlock(keyFingerprint(activeKey(publisher)))) {
        ui.say('compromisedProofSkipped');
        return null;
    }
    ui.say(automatic ? 'proofAutomaticHelp' : 'proofManualHelp');
    if (!await ui.confirm('optionalKey', { keyId: activeKey(publisher).keyId })) return null;
    const key = activeKey(publisher);
    const fingerprint = hash(Buffer.from(key.publicKeySpkiBase64, 'base64'));
    const prior = context.keyStore?.key(fingerprint) ?? context.store?.key(fingerprint);
    const privateFile = keyLocation(await ui.ask('privateKey', prior?.privateFile ?? '', value => keyLocation(value, projectRoot),
        { identity: fingerprint, remember: false }), projectRoot);
    const publicFile = context.sdk.save(Buffer.from('-----BEGIN PUBLIC KEY-----\n' + key.publicKeySpkiBase64 + '\n-----END PUBLIC KEY-----\n'), '.pem');
    await unlockPrivateKey(context, privateFile, publicFile);
    if (!await ui.confirm('keyAction', { privateFile, keyId: activeKey(publisher).keyId })) throw new Error('CANCELLED');
    (context.keyStore ?? context.store)?.update({ key: { keyId: key.keyId, fingerprint, privateFile } }, { selected: false });
    return { keyId: activeKey(publisher).keyId, privateFile };
}

export async function prepareRotation(context, rotation) {
    const { ui, sdk, sign } = context;
    if (!rotation) {
        const { state, snapshot, call = github } = context;
        const publishers = [...state.tree.keys()].filter(file => /^publishers\/[1-9][0-9]*\/[^/]+\.json$/u.test(file))
            .map(file => state.read(file, 'PUBLISHER')).filter(record => eligible({ accountId: record.value.githubAccount.id,
                accountType: record.value.githubAccount.type }, snapshot.actor, call));
        if (!publishers.length) unavailable(ui, 'NO_OWNED_PUBLISHERS');
        const existing = await ui.select('selectPublisher', publishers, record => `${record.value.publisherId} · ${record.value.githubAccount.loginAtRegistration ?? record.value.githubAccount.id} · ${ui.text(record.value.githubAccount.type === 'User' ? 'personal' : 'organization')} (#${record.value.githubAccount.id})`);
        const owner = { accountId: existing.value.githubAccount.id, accountType: existing.value.githubAccount.type, publisherId: existing.value.publisherId };
        context.bindPublisher?.(owner);
        if (owner.accountType === 'Organization' && !await ui.confirm('representation', owner)) throw new Error('CANCELLED');
        bindPublisherHistory(context, owner);
        rotation = { owner, existing, selectedKey: await signingKey(context, existing.value.signingKeys, { rotation: true }) };
    }
    const { owner, existing, selectedKey } = rotation;
    context.bindPublisher?.(owner);
    if (existing.value.signingKeys.some(key => key.keyId === selectedKey.key.keyId || key.publicKeySpkiBase64 === selectedKey.key.publicKeySpkiBase64)) {
        // 从发布入口进入换钥时，也在密钥步骤内修正冲突。
        rotation.selectedKey = await signingKey(context, existing.value.signingKeys, { rotation: true });
        return prepareRotation(context, rotation);
    }
    const payload = { publisherId: owner.publisherId, githubAccount: { id: owner.accountId, type: owner.accountType },
        publisherRecordSha256: existing.sha256, oldKeyId: activeKey(existing.value).keyId, newKey: selectedKey.key,
        reasonCode: await ui.select('reason', ['ROUTINE_ROTATION', 'KEY_LOST', 'KEY_COMPROMISED']), explanation: await ui.ask('explanation') };
    if (payload.reasonCode === 'KEY_COMPROMISED' && !(context.emergency ?? emergencyState(sdk, context.call ?? github))
        .readBlock(keyFingerprint(activeKey(existing.value)))) unavailable(ui, 'KEY_COMPROMISE_DECLARATION_REQUIRED');
    const proofs = { newKey: { keyId: selectedKey.key.keyId, privateFile: selectedKey.privateFile } };
    const automatic = owner.accountType === 'User' && payload.reasonCode === 'ROUTINE_ROTATION';
    const old = await currentProof(context, existing.value, automatic);
    if (old) proofs.oldKey = old;
    ui.say(automatic && old ? 'statusSigned' : 'rotationManual');
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
    if (!bindings.length) unavailable(ui, partiesOnly ? 'NO_OWNED_PLUGINS' : 'NO_REGISTERED_PLUGINS');
    const selected = await ui.select('plugin', bindings, record => `${record.value.pluginId} (${record.value.owner.publisherId})`);
    bindHistory(context, selected.value.pluginId);
    if (partiesOnly && selected.value.owner.accountType === 'Organization' && !await ui.confirm('representation', selected.value.owner)) throw new Error('CANCELLED');
    return selected;
}

function bindHistory(context, pluginId) {
    const prior = context.state.published(pluginId)[0];
    if (!prior) return;
    const submission = context.sdk.document('SUBMISSION', context.state.reference(prior.value.submissionRef), prior.value.submissionRef.path).value;
    const name = new URL(submission.source.repository).pathname.slice(1);
    const repository = checkedRepository(name, context.call ?? github);
    context.bindProject?.(id(repository.id), submission.buildProfile.projectDir, pluginId);
}

export function bindPublisherHistory(context, owner) {
    const binding = [...context.state.tree.keys()].filter(file => /^plugin-bindings\/[^/]+\.json$/u.test(file))
        .map(file => context.state.read(file, 'BINDING')).find(record => isDeepStrictEqual(record.value.owner, owner));
    if (binding) bindHistory(context, binding.value.pluginId);
}

export async function prepareStatus(context, action) {
    const { state, ui, sdk, sign, snapshot } = context;
    const binding = await selectBinding(context);
    const { owner, pluginId } = binding.value;
    context.bindPublisher?.(owner);
    const versions = state.published(pluginId).filter(record => {
        const current = state.currentStatus(pluginId, record.value.version, record.value.package.sha256).state;
        return action === 'UNYANK' ? current === 'YANKED' : action === 'YANK' ? current === 'ACTIVE' : current !== 'REVOKED';
    });
    if (!versions.length) unavailable(ui, 'NO_ELIGIBLE_VERSIONS', { pluginId, action });
    const published = await ui.select('version', versions, record => `${record.value.version} (${record.value.package.sha256})`);
    const reasons = { YANK: ['FUNCTIONAL_DEFECT', 'COMPATIBILITY_PROBLEM', 'MAINTAINER_WITHDRAWAL', 'LICENSE_ISSUE', 'OTHER'],
        UNYANK: ['ISSUE_RESOLVED', 'YANK_IN_ERROR', 'OTHER'], REVOKE: ['MALICIOUS_CODE', 'KEY_COMPROMISE', 'CRITICAL_VULNERABILITY', 'ARTIFACT_TAMPERING', 'OTHER'] };
    const payload = { owner, requester: { id: snapshot.actor.id, type: 'User' }, pluginBindingSha256: binding.sha256, pluginId,
        version: published.value.version, packageSha256: published.value.package.sha256, action,
        reasonCode: await ui.select('reason', reasons[action]), explanation: await ui.ask('explanation') };
    if (action === 'UNYANK') payload.yankedDecisionSha256 = state.currentStatus(pluginId, payload.version, payload.packageSha256).decisionSha256;
    const publisher = state.read(publisherPath(owner), 'PUBLISHER');
    if (!publisher) throw new Error('PUBLISHER_MISSING');
    const proof = await currentProof(context, publisher.value, owner.accountType === 'User');
    ui.say(proof && owner.accountType === 'User' ? 'statusSigned' : 'statusManual');
    const request = signOperation(sdk, sign, 'STATUS_REQUEST', { schemaVersion: 1, payload }, proof ? { activeKey: proof } : {});
    return { changes: new Map([[`version-status-requests/${owner.accountId}/${pluginId}/${payload.version}/${request.requestId}.json`, encoded(request)]]),
        title: `chore(plugin): ${action} ${pluginId} ${payload.version}` };
}

// 在最终预览重新确认，包含从本地保存的已签名请求恢复的路径。
export async function confirmRevocation(ui, result, changes) {
    if (result.operation !== 'REVOKE') return;
    const { pluginId, version, packageSha256 } = JSON.parse(changes.get(result.requestPath).toString('utf8')).payload;
    ui.say('revokeWarning', { pluginId, version, packageSha256 });
    await ui.ask('revokeIdentity', '', value => {
        if (value !== pluginId + '@' + version) throw new Error('REVOKE_CONFIRMATION_MISMATCH');
    });
}

export async function prepareTransfer(context) {
    const { state, ui, snapshot, sdk, sign, call = github } = context;
    const requests = [...state.tree.keys()].filter(file => /^ownership-transfers\/[^/]+\/[^/]+\/proposal\.json$/u.test(file))
        .map(file => state.read(file, 'TRANSFER')).filter(record => {
            const request = record.value;
            if (state.read(`audits/${request.requestId}.json`, 'AUDIT')) return false;
            if (state.read(`plugin-bindings/${request.payload.pluginId}.json`, 'BINDING')?.sha256 !== request.payload.pluginBindingSha256) return false;
            const target = state.read(publisherPath(request.payload.to), 'PUBLISHER');
            if ((target?.sha256 ?? null) !== request.payload.targetPublisherRecordSha256) return false;
            return ['FROM', 'TO'].some(role => eligible(role === 'FROM' ? request.payload.from : request.payload.to, snapshot.actor, call)
                && !state.tree.has(`ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/${role.toLowerCase()}/${snapshot.actor.id}.json`));
        });
    const proposal = await ui.select('proposal', [null, ...requests], record => record ? `${record.value.payload.pluginId} (${record.value.requestId})` : ui.text('newProposal'));
    const changes = new Map();
    let request;
    if (proposal) { request = proposal.value; bindHistory(context, request.payload.pluginId); }
    else {
        const binding = await selectBinding(context, false);
        const login = await ui.ask('targetLogin', snapshot.actor.login, value => { if (!/^[A-Za-z0-9-]+$/u.test(value)) throw new Error('GITHUB_LOGIN_INVALID'); });
        if (!/^[A-Za-z0-9-]+$/u.test(login)) throw new Error('GITHUB_LOGIN_INVALID');
        const account = call(`users/${login}`);
        if (!['User', 'Organization'].includes(account.type) || account.login.toLowerCase() !== login.toLowerCase()) throw new Error('TARGET_ACCOUNT_INVALID');
        const to = { accountId: id(account.id), accountType: account.type, publisherId: await ui.ask('publisher', account.login.toLowerCase(),
            value => sdk.invoke({ command: 'field', field: 'publisher', value })) };
        if (isDeepStrictEqual(binding.value.owner, to)) unavailable(ui, 'TRANSFER_SAME_OWNER');
        if (!eligible(binding.value.owner, snapshot.actor, call) && !eligible(to, snapshot.actor, call)) throw new Error('TRANSFER_PARTY_REQUIRED');
        if (!eligible(to, snapshot.actor, call)) unavailable(ui, 'TRANSFER_RECIPIENT_START_REQUIRED');
        const target = state.read(publisherPath(to), 'PUBLISHER');
        context.bindPublisher?.(to);
        const selectedKey = await signingKey(context, target?.value.signingKeys ?? []);
        if (target && (selectedKey.key.keyId !== activeKey(target.value).keyId
            || selectedKey.key.publicKeySpkiBase64 !== activeKey(target.value).publicKeySpkiBase64)) throw new Error('TARGET_KEY_CHANGED');
        const payload = { pluginId: binding.value.pluginId, pluginBindingSha256: binding.sha256, from: binding.value.owner, to,
            targetPublisherRecordSha256: target?.sha256 ?? null, targetKey: target ? { keyId: selectedKey.key.keyId } : selectedKey.key,
            ...(!target ? { targetPublisherDisplayName: await ui.ask('display', account.login) } : {}),
            mode: await ui.select('mode', ['REGULAR', 'RECOVERY']), explanation: await ui.ask('explanation') };
        if (payload.mode === 'RECOVERY') {
            const files = await ui.ask('evidence', '', value => {
                const files = value.split(',').map(file => file.trim());
                if (files.some(file => !file)) throw new Error('RECOVERY_EVIDENCE_REQUIRED');
                let total = 0;
                const hashes = new Set();
                for (const file of files) {
                    const bytes = readFile(path.resolve(context.projectRoot, file));
                    if (!bytes.length) throw new Error('RECOVERY_EVIDENCE_REQUIRED');
                    if ((total += bytes.length) > 32 * 1024 * 1024) throw new Error('INPUT_SIZE_EXCEEDED');
                    if (hashes.has(hash(bytes))) throw new Error('RECOVERY_EVIDENCE_DUPLICATED');
                    hashes.add(hash(bytes));
                }
            });
            payload.recoveryEvidence = [];
            let total = 0;
            for (const file of files.split(',').map(value => value.trim())) {
                const bytes = readFile(path.resolve(context.projectRoot, file));
                if (!bytes.length || (total += bytes.length) > 32 * 1024 * 1024) throw new Error('INPUT_SIZE_EXCEEDED');
                const relative = `ownership-transfer-evidence/${payload.pluginId}/${hash(bytes)}.bin`;
                if (payload.recoveryEvidence.some(ref => ref.path === relative)) throw new Error('RECOVERY_EVIDENCE_DUPLICATED');
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
        const approvalPath = `ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/${role.toLowerCase()}/${snapshot.actor.id}.json`;
        if (state.tree.has(approvalPath)) continue;
        if (!eligible(owner, snapshot.actor, call)) continue;
        if (owner.accountType === 'Organization' && !await ui.confirm('representation', owner)) continue;
        if (!await ui.confirm('transfer', { role, proposal: request })) continue;
        changes.set(approvalPath,
            encoded({ schemaVersion: 1, requestId: request.requestId, role }));
    }
    if (!changes.size) throw new Error('CANCELLED');
    return { changes, title: `feat(plugin): transfer ${request.payload.pluginId} ownership` };
}
