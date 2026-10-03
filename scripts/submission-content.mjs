import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from './submission-fields.mjs';
import { hash } from './sdk.mjs';
import { download } from './download.mjs';

export const contentTag = (pluginId, version) => `market-content-${pluginId}-${version}`;

export async function contentFields(context, sourceRoot, source, market, facts, projectDir) {
    const { sdk, ui } = context;
    const limits = sdk.invoke({ command: 'content-limits' });
    const files = new Map();
    const content = {};
    const locale = market.defaultLocale;
    const baseUrl = `${source.repository}/releases/download/${encodeURIComponent(contentTag(facts.pluginId, facts.version))}/`;
    const asset = (bytes, mediaType, pending) => {
        const extension = { 'text/markdown': 'md', 'text/html': 'html', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mediaType];
        if (!extension) throw new Error('SCHEMA_INVALID');
        const sha256 = hash(bytes), name = `content-${sha256}.${extension}`;
        pending.set(name, bytes);
        return { name, url: baseUrl + name, mediaType, size: bytes.length, sha256 };
    };
    const inspect = (file, format) => sdk.invoke({ command: 'content-inspect', root: path.dirname(file), path: path.basename(file), format });
    const freeze = async (input, purpose) => {
        // 预览、解析和上传共享同一次读取，后续修改原文件不能改变已确认的字节。
        const bytes = readFile(input.file, limits.documentBytes);
        const information = inspect(sdk.save(bytes, '.document'), input.format);
        const pending = new Map();
        const retain = (bytes, type) => asset(bytes, type, pending);
        const document = { format: input.format, asset: retain(bytes, `text/${input.format}`),
            ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), resources: {} };
        const external = information.images.filter(url => url.startsWith('https://'));
        const includeExternal = external.length && await ui.confirm('contentExternal', { urls: external });
        let imageRoot = input.root;
        if (!imageRoot && information.images.some(url => !url.startsWith('https://'))) {
            imageRoot = await ui.ask('contentRoot', context.projectRoot, value => {
                sdk.invoke({ command: 'path', root: value, path: '.', allowRoot: true, mustExist: true });
            }, { identity: [purpose, information.sha256], remember: false });
        }
        for (const original of information.images) {
            if (original.startsWith('https://') && !includeExternal) continue;
            try {
                let bytes;
                if (original.startsWith('https://')) {
                    const temporary = path.join(sdk.workspace, randomUUID() + '.image');
                    await (context.contentDownload ?? download)(original, temporary, limits.imageBytes);
                    bytes = readFile(temporary, limits.imageBytes);
                } else {
                    const relative = sdk.invoke({ command: 'content-resource', sourcePath: input.sourcePath, path: original }).path;
                    const file = sdk.invoke({ command: 'path', root: imageRoot, path: relative, mustExist: true }).path;
                    bytes = readFile(file, limits.imageBytes);
                }
                const metadata = sdk.invoke({ command: 'image', file: sdk.save(bytes, '.image'), icon: false });
                document.resources[original] = retain(bytes, metadata.mediaType);
                sdk.invoke({ command: 'content', value: { ...content, [purpose]: { [locale]: document } }, locale });
            } catch (error) {
                delete document.resources[original];
                const referenced = new Set([document.asset.name, ...Object.values(document.resources).map(value => value.name)]);
                for (const name of pending.keys()) if (!referenced.has(name)) pending.delete(name);
                if (['CANCELLED', 'WIZARD_BACK', 'WIZARD_SAVE'].includes(error.message)) throw error;
                if (!await ui.confirm('contentResource', { path: original, code: error.code ?? error.message })) throw new Error('CANCELLED');
            }
        }
        sdk.invoke({ command: 'content', value: { ...content, [purpose]: { [locale]: document } }, locale });
        if (!await ui.confirm('contentPreview', { purpose, locale, ...document, contentText: bytes.toString('utf8') })) return null;
        for (const [name, value] of pending) files.set(name, value);
        return document;
    };
    for (const purpose of ['releaseNotes', 'readme']) {
        for (;;) {
            const candidates = (purpose === 'releaseNotes' ? ['CHANGELOG.md'] : ['README.md', 'README.html', 'README.htm'])
                .flatMap(name => [...new Set([path.posix.join(projectDir, name), name])])
                .filter(relative => fs.existsSync(path.join(sourceRoot, relative)));
            const choice = await ui.select(purpose === 'readme' ? 'readmeSource' : 'changelogSource',
                purpose === 'readme' ? ['contentNone', 'contentRepository', 'contentLocal', 'contentManual']
                    : ['contentRepository', 'contentLocal', 'contentManual', 'contentNone'], key => ui.text(key));
            if (choice === 'contentNone') break;
            let input;
            try {
                if (choice === 'contentManual') {
                    const format = purpose === 'releaseNotes' ? 'markdown' : await ui.select('contentFormat', ['markdown', 'html']);
                    const text = await ui.multiline('contentInput', '', value => {
                        if (Buffer.byteLength(value, 'utf8') > limits.manualBytes) throw new Error('INPUT_SIZE_EXCEEDED');
                        inspect(sdk.save(Buffer.from(value, 'utf8'), '.document'), format);
                    }, { identity: [purpose, format], remember: false });
                    input = { file: sdk.save(Buffer.from(text, 'utf8'), '.document'), format };
                } else {
                    const repositoryFile = choice === 'contentRepository';
                    const resolve = value => repositoryFile
                        ? sdk.invoke({ command: 'path', root: sourceRoot, path: value, mustExist: true }).path : path.resolve(value);
                    const selected = await ui.ask('contentPath', repositoryFile ? candidates[0] ?? '' : '', value => {
                        readFile(resolve(value), limits.documentBytes);
                    }, { identity: [purpose, choice, source.commit], remember: false });
                    const file = resolve(selected);
                    input = { file, root: repositoryFile ? sourceRoot : path.dirname(file),
                        sourcePath: repositoryFile ? selected : path.basename(file),
                        format: purpose === 'releaseNotes' ? 'markdown' : await ui.select('contentFormat', ['markdown', 'html'], undefined,
                            /\.html?$/iu.test(selected) ? 'html' : 'markdown') };
                }
                input = { ...input, file: sdk.save(readFile(input.file, limits.documentBytes), '.document') };
                const original = input;
                if (purpose === 'releaseNotes' && choice !== 'contentManual') {
                    input = { ...input, file: sdk.invoke({ command: 'changelog', root: path.dirname(input.file),
                        path: path.basename(input.file), version: facts.version }).file };
                }
                const document = await freeze(input, purpose);
                if (!document) continue;
                content[purpose] = { [locale]: document };
                if (purpose === 'releaseNotes' && choice !== 'contentManual' && await ui.confirm('contentFullChangelog', { path: original.sourcePath })) {
                    const full = await freeze(original, 'changelog');
                    if (full) content.changelog = { [locale]: full };
                }
                break;
            } catch (error) {
                if (['CANCELLED', 'WIZARD_BACK', 'WIZARD_SAVE'].includes(error.message)) throw error;
                ui.say('contentMissing', { code: error.code ?? error.message });
            }
        }
    }
    if (!Object.keys(content).length) return { files: new Map() };
    const expected = sdk.invoke({ command: 'content', value: content, locale });
    return { content, files: new Map(Object.keys(expected).map(name => [name, files.get(name)])) };
}
