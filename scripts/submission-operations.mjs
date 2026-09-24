import { selectTransfer, reviewTransfer } from './submission-transfer.mjs';
import { activeKey, publisherPath } from './submission-check.mjs';
import { eligible, github, checkedRepository } from './submission-github.mjs';
import { id } from './github.mjs';
import { hash } from './sdk.mjs';
import { signingKey, publisherOwner } from './submission-release.mjs';
import { signOperation, keyLocation, unlockPrivateKey } from './submission-signing.mjs';
import { readFile } from './submission-fields.mjs';
import { unavailable } from './submission-navigation.mjs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { keyLabel } from './submission-emergency.mjs';
import { emergencyState, keyFingerprint } from './emergency-state.mjs';
import { versionState, canChangeVersion, transferVersionNotice } from './submission-version-state.mjs';

const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');

export async function currentProof(context, publisher, automatic) {
    const { ui, projectRoot } = context;
    const owner = { accountId: publisher.githubAccount.id, accountType: publisher.githubAccount.type, publisherId: publisher.publisherId };
    ui.say('keyContext', keyLabel(context, owner, activeKey(publisher)));
    const emergency = context.emergency ?? emergencyState(context.sdk, context.call ?? github);
    if (emergency.readBlock(keyFingerprint(activeKey(publisher)))) {
        ui.say('compromisedProofSkipped');
        return null;
    }
    ui.say(automatic ? 'proofAutomaticHelp' : 'proofManualHelp');
    if (await ui.select('proofMethod', ['provideProof', 'skipProof'], value => ui.text(value)) === 'skipProof') return null;
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
        rotation = { owner, existing };
    }
    const { owner, existing } = rotation;
    context.bindPublisher?.(owner);
    ui.say('rotationVersionNotice');
    const reasonCode = await ui.select('reason', ['ROUTINE_ROTATION', 'KEY_LOST', 'KEY_COMPROMISED']);
    if (reasonCode === 'KEY_COMPROMISED' && !(context.emergency ?? emergencyState(sdk, context.call ?? github))
        .readBlock(keyFingerprint(activeKey(existing.value)))) unavailable(ui, 'KEY_COMPROMISE_DECLARATION_REQUIRED');
    let selectedKey = rotation.selectedKey;
    if (!selectedKey || existing.value.signingKeys.some(key => key.keyId === selectedKey.key.keyId || key.publicKeySpkiBase64 === selectedKey.key.publicKeySpkiBase64)) {
        // 从发布入口进入换钥时，也在密钥步骤内修正冲突。
        selectedKey = await signingKey(context, existing.value.signingKeys, { rotation: true });
    }
    const payload = { publisherId: owner.publisherId, githubAccount: { id: owner.accountId, type: owner.accountType },
        publisherRecordSha256: existing.sha256, oldKeyId: activeKey(existing.value).keyId, newKey: selectedKey.key,
        reasonCode, explanation: await ui.ask('explanation') };
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
    if (!partiesOnly) {
        if (![...state.tree.keys()].some(file => /^plugin-bindings\/[^/]+\.json$/u.test(file))) unavailable(ui, 'NO_REGISTERED_PLUGINS');
        const format = value => {
            if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/u.test(value)) throw new Error('PLUGIN_IDENTITY_INVALID');
        };
        const lookup = value => {
            format(value);
            const [publisherId, pluginId] = value.split('/');
            const binding = state.read(`plugin-bindings/${pluginId}.json`, 'BINDING');
            if (!binding) throw new Error('PLUGIN_NOT_REGISTERED');
            if (binding.value.owner.publisherId !== publisherId) throw new Error('PLUGIN_PUBLISHER_MISMATCH');
            if (binding.value.owner.accountType === 'User' && binding.value.owner.accountId === snapshot.actor.id) throw new Error('TRANSFER_SAME_OWNER');
            return binding;
        };
        for (;;) {
            const value = await ui.ask('transferPlugin', '', format);
            try {
                const selected = lookup(value);
                bindHistory(context, selected.value.pluginId);
                return selected;
            } catch (error) {
                if (!['PLUGIN_NOT_REGISTERED', 'PLUGIN_PUBLISHER_MISMATCH', 'TRANSFER_SAME_OWNER'].includes(error.message)) throw error;
                ui.say('transferPlugin', { code: error.message });
            }
        }
    }
    const cache = new Map();
    const authorized = owner => {
        const key = `${owner.accountType}/${owner.accountId}`;
        if (!cache.has(key)) cache.set(key, eligible(owner, snapshot.actor, call));
        return cache.get(key);
    };
    const bindings = [...state.tree.keys()].filter(file => /^plugin-bindings\/[^/]+\.json$/u.test(file))
        .map(file => state.read(file, 'BINDING')).filter(record => authorized(record.value.owner));
    if (!bindings.length) unavailable(ui, 'NO_OWNED_PLUGINS');
    const selected = await ui.select('plugin', bindings, record => `${record.value.pluginId} (${record.value.owner.publisherId})`);
    bindHistory(context, selected.value.pluginId);
    if (selected.value.owner.accountType === 'Organization' && !await ui.confirm('representation', selected.value.owner)) throw new Error('CANCELLED');
    return selected;
}

function bindHistory(context, pluginId) {
    if (context.projectRoot === null) return;
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
    const all = state.published(pluginId);
    if (!all.length) unavailable(ui, 'NO_PUBLISHED_VERSIONS', { pluginId });
    const histories = new Map(all.map(record => [record, state.currentStatus(pluginId, record.value.version, record.value.package.sha256)]));
    const states = new Map(all.map(record => [record, versionState(state, record, histories.get(record))]));
    const versions = all.filter(record => canChangeVersion(action, states.get(record).currentState, histories.get(record).state));
    ui.say('effect' + action);
    if (!versions.length) unavailable(ui, 'NO_ELIGIBLE_VERSIONS', { pluginId, operation: action, versions: [...states.values()] });
    const published = await ui.select('version', versions, record => `${record.value.version} · ${ui.text('option.' + states.get(record).currentState)} (${states.get(record).currentState}) · ${record.value.package.sha256}`);
    ui.say('selectedVersionState', states.get(published));
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
    if (!['YANK', 'UNYANK', 'REVOKE'].includes(result.operation)) return;
    ui.say('effect' + result.operation);
    if (result.operation !== 'REVOKE') return;
    const { pluginId, version, packageSha256 } = JSON.parse(changes.get(result.requestPath).toString('utf8')).payload;
    ui.say('revokeWarning', { pluginId, version, packageSha256 });
    await ui.ask('revokeIdentity', '', value => {
        if (value !== pluginId + '@' + version) throw new Error('REVOKE_CONFIRMATION_MISMATCH');
    });
}

export async function prepareTransfer(context) {
    const { state, ui, snapshot, sdk, sign, call = github } = context;
    ui.say('transferHelp');
    const action = await ui.select('transferAction', ['newProposal', 'transferConfirmFrom', 'transferHandoff'], value => ui.text(value));
    if (action === 'transferHandoff') {
        const binding = await selectBinding(context);
        transferVersionNotice(context, binding.value.pluginId);
        ui.say('transferHandoffHelp', { pluginIdentity: `${binding.value.owner.publisherId}/${binding.value.pluginId}` });
        throw new Error('WIZARD_MENU');
    }
    if (action === 'transferConfirmFrom') return reviewTransfer(context, await selectTransfer(context));
    const changes = new Map();
    const binding = await selectBinding(context, false);
    transferVersionNotice(context, binding.value.pluginId);
    ui.say('transferRecipientHelp', { pluginId: binding.value.pluginId, from: binding.value.owner });
    const to = await publisherOwner(context, null, { ownerLabel: 'recipientOwner', publisherLabel: 'recipientPublisher' });
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
        ...(!target ? { targetPublisherDisplayName: await ui.ask('recipientDisplay', to.publisherId) } : {}),
        mode: await ui.select('mode', ['REGULAR', 'RECOVERY']), explanation: await ui.ask('explanation') };
    if (payload.mode === 'RECOVERY') {
        const files = await ui.ask('evidence', '', value => {
            const files = value.split(',').map(file => file.trim());
            if (files.some(file => !file)) throw new Error('RECOVERY_EVIDENCE_REQUIRED');
            let total = 0;
            const hashes = new Set();
            for (const file of files) {
                const bytes = readFile(path.resolve(context.projectRoot ?? context.directory, file));
                if (!bytes.length) throw new Error('RECOVERY_EVIDENCE_REQUIRED');
                if ((total += bytes.length) > 32 * 1024 * 1024) throw new Error('INPUT_SIZE_EXCEEDED');
                if (hashes.has(hash(bytes))) throw new Error('RECOVERY_EVIDENCE_DUPLICATED');
                hashes.add(hash(bytes));
            }
        });
        payload.recoveryEvidence = [];
        let total = 0;
        for (const file of files.split(',').map(value => value.trim())) {
            const bytes = readFile(path.resolve(context.projectRoot ?? context.directory, file));
            if (!bytes.length || (total += bytes.length) > 32 * 1024 * 1024) throw new Error('INPUT_SIZE_EXCEEDED');
            const relative = `ownership-transfer-evidence/${payload.pluginId}/${hash(bytes)}.bin`;
            if (payload.recoveryEvidence.some(ref => ref.path === relative)) throw new Error('RECOVERY_EVIDENCE_DUPLICATED');
            if (state.tree.has(relative)) {
                if (hash(state.raw(relative)) !== hash(bytes)) throw new Error('RECOVERY_EVIDENCE_MISMATCH');
            } else changes.set(relative, bytes);
            payload.recoveryEvidence.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
        }
    }
    const request = signOperation(sdk, sign, 'TRANSFER', { schemaVersion: 1, payload },
        { targetKey: { keyId: selectedKey.key.keyId, privateFile: selectedKey.privateFile } });
    changes.set(`ownership-transfers/${payload.pluginId}/${request.requestId}/proposal.json`, encoded(request));
    for (const role of ['FROM', 'TO']) {
        const owner = role === 'FROM' ? request.payload.from : request.payload.to;
        const approvalPath = `ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/${role.toLowerCase()}/${snapshot.actor.id}.json`;
        if (state.tree.has(approvalPath)) continue;
        if (!eligible(owner, snapshot.actor, call)) continue;
        if (owner.accountType === 'Organization' && !await ui.confirm('representation', owner)) throw new Error('CANCELLED');
        if (!await ui.confirm('transfer', { role, proposal: request })) throw new Error('CANCELLED');
        changes.set(approvalPath,
            encoded({ schemaVersion: 1, requestId: request.requestId, role }));
    }
    if (!changes.has(`ownership-transfers/${request.payload.pluginId}/${request.requestId}/approvals/to/${snapshot.actor.id}.json`)) throw new Error('CANCELLED');
    return { changes, title: `feat(plugin): transfer ${request.payload.pluginId} ownership` };
}
