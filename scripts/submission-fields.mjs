import fs from 'node:fs';
import path from 'node:path';
import { root, hash } from './sdk.mjs';
import { API_BYTES } from './github.mjs';
import { git } from './project.mjs';

export function readFile(file, maximum = API_BYTES) {
    if (!fs.lstatSync(file).isFile()) throw new Error('REGULAR_FILE_REQUIRED');
    const descriptor = fs.openSync(file, 'r');
    try {
        const chunks = [];
        let total = 0;
        for (;;) {
            const buffer = Buffer.alloc(Math.min(8192, maximum + 1 - total));
            const count = fs.readSync(descriptor, buffer);
            if (!count) return Buffer.concat(chunks, total);
            total += count;
            if (total > maximum) throw new Error('INPUT_SIZE_EXCEEDED');
            chunks.push(buffer.subarray(0, count));
        }
    } finally { fs.closeSync(descriptor); }
}

export async function licenseFields(sdk, ui, projectRoot, projectDir = '.', previous) {
    const tracked = git(projectRoot, 'ls-files', '-z').split('\0').filter(Boolean);
    const licenses = tracked.filter(file => /^(?:LICENSE|LICENCE|COPYING)(?:[-._].*)?$/iu.test(path.posix.basename(file)));
    const selected = licenses.filter(file => path.posix.dirname(file) === projectDir);
    const suggestions = selected.length ? selected : licenses.filter(file => path.posix.dirname(file) === '.');
    const templates = sdk.invoke({ command: 'licenses' }).map(template => template.id);
    ui.say?.('licenseNotice');
    if (await ui.select('licenseAction', ['existingLicense', 'createLicense'], key => ui.text(key)) === 'createLicense') {
        const id = await ui.select('licenseTemplate', templates);
        const template = sdk.invoke({ command: 'license', id });
        let text = readFile(template.file).toString('utf8');
        if (['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'].includes(id) && /<year>|\bYEAR\b/u.test(text)) {
            const year = await ui.ask('year', String(new Date().getFullYear()), value => {
                if (!/^[0-9]{4}(?:-[0-9]{4})?$/u.test(value)) throw new Error('COPYRIGHT_INPUT_INVALID');
            });
            const holder = await ui.ask('copyright', '', value => {
                if (!value || /[\r\n<>]/u.test(value)) throw new Error('COPYRIGHT_INPUT_INVALID');
            });
            if (!/^[0-9]{4}(?:-[0-9]{4})?$/u.test(year) || !holder || /[\r\n<>]/u.test(holder)) throw new Error('COPYRIGHT_INPUT_INVALID');
            text = text.replaceAll('<year>', year).replaceAll('<copyright holders>', holder).replaceAll('<owner>', holder);
            if (id === '0BSD') text = text.replace('YEAR', year).replace('AUTHOR EMAIL', holder);
        }
        const output = value => {
            const file = sdk.invoke({ command: 'path', root: projectRoot, path: value, mustExist: false }).path;
            if (fs.existsSync(file)) throw new Error('LICENSE_FILE_EXISTS');
            if (!fs.statSync(path.dirname(file)).isDirectory()) throw new Error('LICENSE_PARENT_REQUIRED');
            return file;
        };
        const defaultPath = path.posix.join(projectDir, suggestions.length ? 'LICENSE.plugin' : 'LICENSE');
        const file = output(await ui.ask('licenseOutput', defaultPath, output));
        if (!await ui.confirm('licenseTemplate', { id, file, text })) throw new Error('CANCELLED');
        fs.writeFileSync(file, text, { flag: 'wx', encoding: 'utf8' });
        ui.say('rebuild');
        return null;
    }
    const reference = file => {
        if (!tracked.includes(file)) throw new Error('LICENSE_COMMIT_REQUIRED');
        const absolute = sdk.invoke({ command: 'path', root: projectRoot, path: file, mustExist: true }).path;
        const bytes = readFile(absolute);
        return { path: file, size: bytes.length, sha256: hash(bytes) };
    };
    const files = (await ui.ask('licenseFiles', previous?.files?.map(file => file.path).join(',') ?? suggestions.join(','), value => {
        const files = value.split(',').map(file => file.trim());
        if (new Set(files).size !== files.length) throw new Error('LICENSE_FILES_DUPLICATED');
        files.forEach(reference);
    })).split(',').map(value => value.trim());
    const references = files.map(reference);
    // 仅完整固定正文匹配才提出已知许可证；不根据单个关键词猜测法律授权。
    const known = new Set();
    let recognized = 0;
    for (const file of files) {
        const actual = readFile(path.join(projectRoot, file)).toString('utf8').replace(/\s+/gu, ' ').trim();
        for (const id of templates) {
            const template = readFile(path.join(root, `schemas/community/v1/licenses/${id}.txt`)).toString('utf8');
            const pattern = template.trim().split(/(<year>|<owner>|<copyright holders>|YEAR|AUTHOR EMAIL|\s+)/u).map(part =>
                /^(?:<.+>|YEAR|AUTHOR EMAIL)$/u.test(part) ? '.+?' : /^\s+$/u.test(part) ? ' ' : part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('');
            if (new RegExp('^' + pattern + '$', 'u').test(actual)) { known.add(id); recognized++; }
        }
    }
    if (known.size > 1) ui.say('license', [...known]);
    const suggestion = known.size === 1 && recognized === files.length ? [...known][0] : null;
    const selectedExpression = suggestion ? await ui.select('license', [suggestion, 'customLicense'], key => key === 'customLicense' ? ui.text(key) : key) : 'customLicense';
    const expression = selectedExpression !== 'customLicense' ? selectedExpression : await ui.ask('license', previous?.expression ?? suggestion ?? '',
        value => {
            sdk.invoke({ command: 'field', field: 'license', value });
            if (known.size === 1 && /^[A-Za-z0-9.-]+$/u.test(value) && !known.has(value)) throw new Error('LICENSE_CONFLICT');
        });
    const result = { expression, files: references };
    const refs = [...new Set(expression.match(/LicenseRef-[A-Za-z0-9.-]+/gu) ?? [])];
    if (refs.length) {
        result.licenseRefs = {};
        for (const ref of refs) result.licenseRefs[ref] = reference(await ui.ask('licenseFiles', previous?.licenseRefs?.[ref]?.path ?? '', value => { reference(value); }));
    }
    if (!await ui.confirm('license', result)) throw new Error('CANCELLED');
    return result;
}

export async function marketFields(sdk, ui, owner, facts, changes, previous, previousAsset) {
    const check = field => value => { if (value) sdk?.invoke({ command: 'field', field, value }); };
    const locale = await ui.ask('locale', previous?.defaultLocale ?? ui.locale ?? 'en-US', check('locale'));
    const market = structuredClone(previous ?? {});
    market.defaultLocale = locale;
    market.displayName = { ...market.displayName, [locale]: await ui.ask('name', previous?.displayName?.[locale] ?? '', check('name')) };
    market.summary = { ...market.summary, [locale]: await ui.ask('summary', previous?.summary?.[locale] ?? '', check('summary')) };
    const description = await ui.ask('description', previous?.description?.[locale] ?? '', check('description'));
    if (description) market.description = { ...market.description, [locale]: description };
    else if (market.description) { delete market.description[locale]; if (!Object.keys(market.description).length) delete market.description; }
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'schemas/community/v1/catalogs.json'), 'utf8'));
    market.category = await ui.select('category', catalog.categories, undefined, previous?.category);
    market.tags = await ui.multiselect('tags', catalog.tags, previous?.tags ?? []);
    const homepage = await ui.ask('homepage', previous?.homepageUrl ?? '', check('homepage'));
    if (homepage) market.homepageUrl = homepage; else delete market.homepageUrl;
    const image = async (file, icon) => {
        const bytes = readFile(path.resolve(file), icon ? 256 * 1024 : 2 * 1024 * 1024);
        const frozen = sdk.save(bytes, '.image');
        const information = sdk.invoke({ command: 'image', file: frozen, icon });
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[information.mediaType];
        const relative = `assets/${owner.accountId}/${facts.pluginId}/${facts.version}/${hash(bytes)}.${extension}`;
        changes.set(relative, bytes);
        return { path: relative, alt: { [locale]: await ui.ask('alt', '', check('alt')) } };
    };
    if (previous?.icon || previous?.screenshots?.length) {
        const action = await ui.select('imageAction', ['keepImages', 'replaceImages', 'clearImages'], value => ui.text(value));
        if (action === 'keepImages') {
            for (const image of [market.icon, ...(market.screenshots ?? [])].filter(Boolean)) {
                const bytes = previousAsset?.(image.path);
                if (!bytes) throw new Error('MARKET_IMAGE_MISSING');
                const extension = path.posix.extname(image.path);
                image.path = `assets/${owner.accountId}/${facts.pluginId}/${facts.version}/${hash(bytes)}${extension}`;
                changes.set(image.path, bytes);
            }
            return market;
        }
        delete market.icon; delete market.screenshots;
        if (action === 'clearImages') return market;
    }
    const icon = await ui.ask('icon', '', value => { if (value) readFile(path.resolve(value), 256 * 1024); });
    if (icon) market.icon = await image(icon, true);
    const screenshots = await ui.ask('screenshots', '', value => {
        if (!value) return;
        const files = value.split(',').map(value => value.trim());
        if (files.length > 6) throw new Error('SCREENSHOT_LIMIT');
        files.forEach(file => readFile(path.resolve(file), 2 * 1024 * 1024));
    });
    if (screenshots) {
        const files = screenshots.split(',').map(value => value.trim());
        if (files.length > 6) throw new Error('SCREENSHOT_LIMIT');
        market.screenshots = [];
        for (const file of files) market.screenshots.push(await image(file, false));
    }
    return market;
}
