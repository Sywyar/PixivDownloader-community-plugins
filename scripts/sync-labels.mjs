import fs from 'node:fs';
import { api, id, list, main, prefix, repository } from './github.mjs';

export const labels = JSON.parse(fs.readFileSync(new URL('labels.json', import.meta.url), 'utf8'));

// 操作类型保留为检索线索；只有状态投影会删除旧标签，标签均不参与授权。
export function updateRequestLabels(number, { operations = [], states }, call = api) {
    if (!Array.isArray(operations) || states !== undefined && !Array.isArray(states)
        || operations.some(name => typeof name !== 'string' || !name.startsWith('type:'))
        || states?.some(name => typeof name !== 'string' || name.startsWith('type:'))) throw new Error('LABEL_PROJECTION_INVALID');
    const desired = [...operations, ...(states ?? [])];
    if (desired.some(name => !labels.some(label => label.name === name))) throw new Error('LABEL_PROJECTION_INVALID');
    const endpoint = `${prefix}/issues/${id(number)}/labels`;
    const current = list(endpoint, null, call).map(label => label.name);
    for (const name of current.filter(name => states !== undefined && !name.startsWith('type:')
        && labels.some(label => label.name === name) && !states.includes(name))) {
        call(`${endpoint}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }
    const missing = [...new Set(desired)].filter(name => !current.includes(name));
    if (missing.length) call(endpoint, { method: 'POST', body: { labels: missing } });
}

export function labelChanges(current, desired = labels) {
    if (new Set(desired.map(label => label.name)).size !== desired.length
        || desired.some(label => !/^[a-z]+:[a-z-]+$/u.test(label.name) || !/^[a-f0-9]{6}$/u.test(label.color)
            || typeof label.description !== 'string')) throw new Error('LABEL_CATALOG_INVALID');
    return desired.flatMap(label => {
        const old = current.filter(item => item.name === label.name);
        if (old.length > 1) throw new Error('LABEL_IDENTITY_AMBIGUOUS');
        if (!old.length) return [{ method: 'POST', path: `${prefix}/labels`, body: label }];
        return old[0].color.toLowerCase() === label.color && old[0].description === label.description ? []
            : [{ method: 'PATCH', path: `${prefix}/labels/${encodeURIComponent(label.name)}`, body: label }];
    });
}

export function syncLabels({ apply = false, call = api } = {}) {
    repository(call, { owner: apply });
    const changes = labelChanges(list(`${prefix}/labels`, null, call));
    if (apply) {
        for (const change of changes) call(change.path, change);
        if (labelChanges(list(`${prefix}/labels`, null, call)).length) throw new Error('LABEL_READBACK_MISMATCH');
    }
    return changes;
}

main(import.meta.url, () => {
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('USAGE: sync-labels.mjs [--apply]');
    console.log(JSON.stringify(syncLabels({ apply: process.argv.includes('--apply') }), null, 2));
});
