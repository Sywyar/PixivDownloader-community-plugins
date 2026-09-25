import { releaseStatus, releaseRestrictions } from './apply-generation.mjs';
import { ownershipState, publicationState, requestCurrentState } from './submission-current-state.mjs';
import { publisherPath } from './submission-check.mjs';
import { keyLabel } from './submission-emergency.mjs';

export function requestedVersionState(state, record, request) {
    const next = state.currentStatus(record.value.pluginId, record.value.version, record.value.package.sha256, request);
    const bytes = state.raw('revocations/restrictions.json');
    if (!bytes) throw new Error('REVOCATIONS_BASELINE_MISSING');
    const entries = JSON.parse(bytes.toString('utf8')).filter(row => row.communityIndependent).map(row => row.entry);
    const remainingRestrictions = releaseRestrictions(record.value, { entries });
    const independent = releaseStatus(record.value, { entries });
    return { requestedState: [next.state, independent].includes('REVOKED') ? 'REVOKED'
        : [next.state, independent].includes('YANKED') ? 'YANKED' : 'ACTIVE',
        remainingRestrictions: remainingRestrictions.map(({ action, reasonCode, effectiveTime }) => ({ currentState: action, reasonCode, effectiveTime })) };
}

// 审计记录描述作者的状态操作；社区独立限制同样影响当前可用性。
export function versionState(state, record, current = state.currentStatus(record.value.pluginId, record.value.version, record.value.package.sha256)) {
    const { pluginId, version, package: artifact } = record.value;
    const restrictions = state.tree.has('revocations.json')
        ? releaseStatus(record.value, JSON.parse(state.raw('revocations.json').toString('utf8'))) : 'ACTIVE';
    const status = [current.state, restrictions].includes('REVOKED') ? 'REVOKED'
        : [current.state, restrictions].includes('YANKED') ? 'YANKED' : 'ACTIVE';
    return { pluginId, version, packageSha256: artifact.sha256, currentState: status };
}

function showVersionState(ui, details) {
    ui.say('version' + details.currentState, details);
}

export function canChangeVersion(action, currentState, authorState) {
    return action === 'UNYANK' ? currentState === 'YANKED' && authorState === 'YANKED'
        : action === 'YANK' ? currentState === 'ACTIVE'
            : action === 'REVOKE' && ['ACTIVE', 'YANKED'].includes(currentState);
}

// 原发布、待审核 PR 和已生效管理请求分别展示，不能把历史记录当成恢复成功。
export function presentOriginal(context, original, changes = new Map()) {
    const { state, ui } = context;
    const value = original.value ?? original;
    if (value.package?.sha256 && value.pluginId && value.version) {
        showVersionState(ui, { ...versionState(state, original), historicalOwner: value.owner,
            ...ownershipState(context, value.pluginId), ...publicationState(value, context.call) });
        return;
    }
    if (value.requestRef && ['YANK', 'UNYANK', 'REVOKE'].includes(value.action)) {
        const request = JSON.parse(state.reference(value.requestRef).toString('utf8'));
        const record = state.published(request.payload.pluginId).find(row => row.value.version === request.payload.version);
        if (!record || record.value.package.sha256 !== request.payload.packageSha256) throw new Error('PUBLISHED_VERSION_MISMATCH');
        ui.say('statusRequestApplied', { operation: value.action, requestId: value.requestId });
        showVersionState(ui, versionState(state, record));
        return;
    }
    if (value.reused) {
        requestVersionNotice(context, changes);
        const facts = requestCurrentState(context, changes.size ? changes : value.changes ?? new Map());
        ui.say(value.draft ? 'requestDraft' : facts.some(row => row.issues.length) ? 'requestStale' : 'requestPending', { url: value.url, head: value.head });
        if (facts.length) ui.say('currentRequestState', facts.map(row => row.current));
        for (const issue of facts.flatMap(row => row.issues)) ui.say('requestStale', issue);
        return;
    }
    ui.say('requestApplied', value);
    if (value.applied && value.owner && value.keys) {
        const publisher = state.read(publisherPath(value.owner), 'PUBLISHER');
        if (!publisher) throw new Error('PUBLISHER_REQUIRED');
        ui.say('keyContext', publisher.value.signingKeys.map(key => keyLabel(context, value.owner, key)));
    }
    if (value.requestRef && ['PUBLISHER_KEY_ROTATION', 'OWNERSHIP_TRANSFER'].includes(value.action)) {
        const request = JSON.parse(state.reference(value.requestRef).toString('utf8')), p = request.payload;
        if (value.action === 'OWNERSHIP_TRANSFER') {
            ui.say('currentRequestState', ownershipState(context, p.pluginId));
            transferVersionNotice(context, p.pluginId);
        } else {
            const owner = { accountId: p.githubAccount.id, accountType: p.githubAccount.type, publisherId: p.publisherId };
            const publisher = state.read(publisherPath(owner), 'PUBLISHER');
            if (!publisher) throw new Error('PUBLISHER_REQUIRED');
            ui.say('keyContext', publisher.value.signingKeys.map(key => keyLabel(context, owner, key)));
        }
    }
}

export function requestVersionNotice(context, changes, requireEligible = false) {
    for (const [file, bytes] of changes) {
        if (!file.startsWith('version-status-requests/')) continue;
        const request = context.sdk.document('STATUS_REQUEST', bytes, file).value;
        const record = context.state.published(request.payload.pluginId).find(row => row.value.version === request.payload.version);
        if (!record || record.value.package.sha256 !== request.payload.packageSha256) throw new Error('PUBLISHED_VERSION_MISMATCH');
        const current = context.state.currentStatus(record.value.pluginId, record.value.version, record.value.package.sha256);
        const details = versionState(context.state, record, current);
        context.ui.say('selectedVersionState', details);
        context.ui.say(details.currentState === 'REVOKED' ? 'revokedRequestState' : 'effect' + request.payload.action);
        if (requireEligible && !canChangeVersion(request.payload.action, details.currentState, current.state)) throw new Error('INVALID_STATE_TRANSITION');
    }
}

export function transferVersionNotice(context, pluginId) {
    const versions = context.state.published(pluginId).map(record => versionState(context.state, record));
    if (versions.some(record => record.currentState !== 'ACTIVE')) context.ui.say('transferVersionStates', { pluginId, versions });
}
