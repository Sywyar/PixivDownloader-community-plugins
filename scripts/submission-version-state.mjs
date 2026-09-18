import { releaseStatus } from './apply-generation.mjs';

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
        showVersionState(ui, versionState(state, original));
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
    if (value.reused) requestVersionNotice(context, changes);
    ui.say(value.reused ? 'requestPending' : 'requestApplied', value);
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
