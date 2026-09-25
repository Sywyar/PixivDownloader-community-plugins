import { id } from './github.mjs';
import { hash } from './sdk.mjs';
import { publisherPath } from './submission-check.mjs';
import { github, eligible } from './submission-github.mjs';
import { emergencyState, keyFingerprint, keyProjects } from './emergency-state.mjs';
import { unavailable } from './submission-navigation.mjs';
import { bindPublisherHistory } from './submission-operations.mjs';

export function emergencyEligible(owner, user, call = github) {
    if (!eligible(owner, user, call)) return false;
    if (owner.accountType === 'User') return true;
    const organization = call(`organizations/${id(owner.accountId)}`);
    return call(`user/memberships/orgs/${organization.login}`).role === 'admin';
}

export function keyLabel(context, owner, key) {
    const projects = context.state ? keyProjects(context.state, owner, key) : [];
    const fingerprint = keyFingerprint(key);
    const emergency = context.emergency ??= emergencyState(context.sdk, context.call ?? github);
    const text = context.ui.text;
    const states = [key.state ?? 'NEW', ...(emergency.readBlock(fingerprint) ? ['DECLARED_COMPROMISED'] : [])];
    const associations = projects.map(project => `${project.pluginId} (${text('option.' + project.relationship)}`
        + `${project.currentOwner ? `; ${text('currentOwner')}: ${project.currentOwner.publisherId} (#${project.currentOwner.accountId})` : ''}`
        + `${project.versions.length ? `; ${text('signedVersions')}: ${project.versions.map(version => `${version.version} ${text('option.' + version.currentState)}`).join(', ')}` : ''})`);
    return `${key.keyId} · ${states.map(state => text('option.' + state)).join(' · ')} · ${text('keyProjects')}: ${associations.join('; ') || text('noKeyProjects')} · ${fingerprint}`;
}

export async function prepareEmergency(context) {
    const { ui, sdk, state, snapshot, call = github } = context;
    const records = [...state.tree.keys()].filter(file => /^publishers\/[1-9][0-9]*\/[^/]+\.json$/u.test(file))
        .map(file => state.read(file, 'PUBLISHER')).filter(record => emergencyEligible({
            accountId: record.value.githubAccount.id, accountType: record.value.githubAccount.type, publisherId: record.value.publisherId,
        }, snapshot.actor, call));
    if (!records.length) unavailable(ui, 'NO_EMERGENCY_PUBLISHERS');
    const publisher = await ui.select('selectPublisher', records, record =>
        `${record.value.publisherId} · ${record.value.githubAccount.loginAtRegistration} (#${record.value.githubAccount.id})`);
    const owner = { accountId: publisher.value.githubAccount.id, accountType: publisher.value.githubAccount.type, publisherId: publisher.value.publisherId };
    context.bindPublisher?.(owner);
    bindPublisherHistory(context, owner);
    const emergency = context.emergency = emergencyState(sdk, call);
    const declared = publisher.value.signingKeys.filter(key => emergency.readBlock(keyFingerprint(key)));
    if (declared.length) ui.say('keyContext', declared.map(key => keyLabel(context, owner, key)));
    const keys = publisher.value.signingKeys.filter(key => !declared.includes(key));
    if (!keys.length) unavailable(ui, 'NO_EMERGENCY_KEYS');
    ui.say('emergencyHelp');
    const labels = keys.map(key => keyLabel(context, owner, key));
    const selected = await ui.multiselect('compromisedKeys', labels);
    if (!selected.length) unavailable(ui, 'NO_EMERGENCY_KEYS_SELECTED');
    const chosen = selected.map(label => keys[labels.indexOf(label)]);
    if (chosen.some(key => !key) || new Set(chosen).size !== chosen.length) throw new Error('EMERGENCY_KEYS_CHANGED');
    if (!await ui.confirm('emergencyConfirm', { publisherId: owner.publisherId, keys: chosen.map(key => ({
        keyId: key.keyId, fingerprint: keyFingerprint(key), projects: keyProjects(state, owner, key),
    })) })) throw new Error('CANCELLED');
    const request = { schemaVersion: 1, payload: { operation: 'DECLARE_KEY_COMPROMISE', owner,
        publisherRecordSha256: publisher.sha256,
        keys: chosen.map(key => ({ keyId: key.keyId, fingerprint: keyFingerprint(key) })) }, requestId: '0'.repeat(64) };
    request.requestId = sdk.invoke({ command: 'canonical', kind: 'EMERGENCY_REQUEST', file: sdk.save(request) }).requestId;
    const file = `requests/${owner.accountId}/${owner.publisherId}/${request.requestId}.json`;
    emergency.unchanged();
    return { changes: new Map([[file, Buffer.from(JSON.stringify(request, null, 2) + '\n')]]),
        title: `fix(publisher): declare ${owner.publisherId} signing key compromise` };
}

// 本地预检不伪造 PR 事实；远端仍从原生作者及可核验的组织管理角色独立授权。
export function validateEmergencySubmission({ sdk, state, changes, user, call = github }) {
    if (changes.size !== 1) throw new Error('EMERGENCY_FILES_INVALID');
    const [file, bytes] = [...changes][0];
    const request = sdk.document('EMERGENCY_REQUEST', bytes, file).value;
    const p = request.payload, publisher = state.read(publisherPath(p.owner), 'PUBLISHER');
    if (!publisher || hash(publisher.bytes) !== p.publisherRecordSha256) throw new Error('PUBLISHER_CHANGED');
    if (!emergencyEligible(p.owner, user, call)) throw new Error('OWNER_AUTHORIZATION_REQUIRED');
    for (const selected of p.keys) if (!publisher.value.signingKeys.some(key =>
        key.keyId === selected.keyId && keyFingerprint(key) === selected.fingerprint)) throw new Error('EMERGENCY_KEYS_CHANGED');
    return { operation: p.operation, owner: p.owner, requestId: request.requestId, keys: p.keys };
}

export function appliedEmergency(sdk, changes, call = github) {
    const state = emergencyState(sdk, call);
    const [file, bytes] = [...changes][0];
    const stored = state.raw(file);
    if (!stored) return null;
    if (!stored.equals(bytes)) throw new Error('EMERGENCY_RECORD_MISMATCH');
    const request = sdk.document('EMERGENCY_REQUEST', bytes, file).value;
    const blocks = request.payload.keys.map(key => state.readBlock(key.fingerprint));
    if (blocks.some(block => !block)) throw new Error('EMERGENCY_RECORDS_MISSING');
    state.unchanged();
    return { requestId: request.requestId, owner: request.payload.owner, keys: request.payload.keys, applied: true };
}
