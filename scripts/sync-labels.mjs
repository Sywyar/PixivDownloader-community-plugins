import fs from 'node:fs';
import { api, list, main, prefix, repository } from './github.mjs';

export const labels = JSON.parse(fs.readFileSync(new URL('labels.json', import.meta.url), 'utf8'));

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
