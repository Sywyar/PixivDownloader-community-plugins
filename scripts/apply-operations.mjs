import { API_BYTES } from './github.mjs';
import { publisherPath } from './submission-check.mjs';
import { hash } from './sdk.mjs';

// 输入的平台身份已由受保护执行器核实；状态迁移及审计格式只由固定 SDK 生成。
export function applyOperation({ sdk, adapter, state, checked, authority, approvals = [], appliedAt, nextUpdate, recoveryEvidence = [] }) {
    const request = state.read(checked.requestPath, { KEY_ROTATION: 'ROTATION', OWNERSHIP_TRANSFER: 'TRANSFER' }[checked.operation] ?? 'STATUS_REQUEST');
    if (!request || request.sha256 !== checked.requestSha256) throw new Error('APPLY_REQUEST_CHANGED');
    const existing = state.read(`audits/${request.value.requestId}.json`, 'AUDIT');
    if (existing) {
        if (!['APPLIED', 'PREPARED'].includes(existing.value.result) || hash(state.reference(existing.value.requestRef)) !== request.sha256) throw new Error('APPLY_REPLAY_CONFLICT');
        for (const ref of [existing.value.beforeRef, existing.value.afterRef, existing.value.decisionRef, ...existing.value.relatedRecords,
            ...(existing.value.recoveryEvidence ?? [])]) state.reference(ref);
        return { replayed: true, audit: existing.value, writes: new Map() };
    }
    const p = request.value.payload;
    const document = (file, kind) => {
        const record = state.read(file, kind);
        return record ? adapter.archive(record.bytes) : null;
    };
    const input = { command: 'operation', operation: checked.operation, request: adapter.archive(request.bytes, checked.requestPath),
        authority, appliedAt, recoveryEvidence, approvals };
    if (checked.operation === 'KEY_ROTATION') input.publisher = document(publisherPath(checked.owner), 'PUBLISHER');
    else {
        input.binding = document(`plugin-bindings/${p.pluginId}.json`, 'BINDING');
        if (checked.operation === 'OWNERSHIP_TRANSFER') {
            input.targetPublisher = document(publisherPath(p.to), 'PUBLISHER');
            input.targetLogin = checked.targetLogin;
            // 转移证据属于已签名请求；批准记录独立保存在 authority，不能替换该列表。
            input.recoveryEvidence = p.recoveryEvidence ?? [];
            for (const ref of p.recoveryEvidence ?? []) adapter.archive(state.reference(ref), ref.path);
        } else {
            input.publisher = document(publisherPath(p.owner), 'PUBLISHER');
            input.state = state.currentStatus(p.pluginId, p.version, p.packageSha256);
            const bytes = state.raw('revocations.json');
            if (!bytes) throw new Error('REVOCATIONS_BASELINE_MISSING');
            input.revocations = adapter.archive(bytes);
            const restrictions = state.raw('revocations/restrictions.json');
            if (!restrictions) throw new Error('REVOCATIONS_BASELINE_MISSING');
            input.restrictions = JSON.parse(restrictions.toString('utf8'));
            for (const item of input.restrictions) adapter.archive(state.reference(item.decisionRef), item.decisionRef.path);
            input.sequence = JSON.parse(bytes.toString('utf8')).sequence + 1;
            if (!Number.isSafeInteger(input.sequence)) throw new Error('REVOCATION_SEQUENCE_EXHAUSTED');
            input.nextUpdate = nextUpdate;
        }
    }
    const writes = decodeWrites(adapter.invoke(input), sdk);
    const auditPath = `audits/${request.value.requestId}.json`;
    const audit = sdk.document('AUDIT', writes.get(auditPath), auditPath).value;
    return { replayed: false, audit, writes };
}

export function decodeWrites(output, sdk) {
    const writes = new Map();
    let total = 0;
    for (const [file, value] of Object.entries(output)) {
        sdk.invoke({ command: 'path', root: sdk.workspace, path: file, mustExist: false });
        if (typeof value !== 'string') throw new Error('APPLY_OUTPUT_INVALID');
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value || (total += bytes.length) > API_BYTES) throw new Error('APPLY_OUTPUT_BUDGET');
        writes.set(file, bytes);
    }
    return writes;
}
