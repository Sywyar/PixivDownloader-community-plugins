import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSubmission } from './local-sdk.mjs';
import { marketLinks } from '../submission-links.mjs';
import { contentFields } from '../submission-content.mjs';
import { navigation } from '../submission-navigation.mjs';
import { publishedContent, publishedImage, verifyCandidateMarket } from '../market-assets.mjs';
import { hash } from '../sdk.mjs';
import { verifyPublicAssets } from '../publication-releases.mjs';
import { contentRelease } from '../submission-content-release.mjs';

const sdk = prepareSubmission();

test('来源内容附件恢复丢失响应，重跑复验公开字节且拒绝异内容', async () => {
    const bytes = Buffer.from('# Original content'), sha256 = hash(bytes), name = `content-${sha256}.md`;
    const repository = 'https://github.com/example/plugin';
    const asset = { name, url: `${repository}/releases/download/market-content-test-8.3.7/${name}`,
        mediaType: 'text/markdown', size: bytes.length, sha256 };
    const submission = { pluginId: 'test', version: '8.3.7', source: { repository, commit: 'c'.repeat(40) },
        market: { defaultLocale: 'en' }, content: { readme: { en: { format: 'markdown', asset, resources: {} } } } };
    let release, creations = 0, uploads = 0, publications = 0, publicReads = 0, corrupt = false;
    const assets = [];
    const call = (endpoint, request = {}) => {
        const route = endpoint.split('?')[0];
        if (route === 'repos/example/plugin') return { id: 101, full_name: 'example/plugin', owner: { id: 102 } };
        if (route === 'repos/example/plugin/releases') {
            if (request.method === 'POST') { creations++; release = { ...request.body, id: 201 }; return structuredClone(release); }
            return [release ? [structuredClone(release)] : []];
        }
        if (route.endsWith('/201/assets')) return [structuredClone(assets)];
        if (route.endsWith('/releases/201')) {
            if (request.method === 'PATCH') { publications++; Object.assign(release, request.body); }
            return structuredClone(release);
        }
        assert.fail(endpoint);
    };
    const options = {
        upload(_prefix, _id, file, received) {
            assert.equal(received, name); assert.deepEqual(fs.readFileSync(file), bytes); uploads++;
            assets.push({ id: 301, name, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256}` });
            throw Object.assign(new Error('lost response'), { github: true });
        },
        transfer(_endpoint, file, maximum, expected) {
            assert.equal(expected.sha256, sha256); assert.equal(maximum, bytes.length); fs.writeFileSync(file, bytes);
        },
        download(url, file, maximum) {
            assert.equal(url, asset.url); assert.equal(maximum, bytes.length); publicReads++;
            fs.writeFileSync(file, corrupt ? 'changed' : bytes);
        },
    };
    const prepared = contentRelease({ sdk, call }, submission, new Map([[name, bytes]]), options);
    await prepared.beforeWrite(); await prepared.beforeWrite();
    assert.deepEqual([creations, uploads, publications, publicReads], [1, 1, 1, 2]);
    corrupt = true;
    await assert.rejects(prepared.beforeWrite(), /CONTENT_ASSET_CHANGED/);
    assert.deepEqual([creations, uploads, publications], [1, 1, 1]);
    assert.throws(() => contentRelease({ sdk, call }, submission, new Map([[name, Buffer.from('other')]]), options), /CONTENT_ASSET_CHANGED/);
    assets[0].digest = 'sha256:' + 'f'.repeat(64);
    await assert.rejects(prepared.beforeWrite(), /CONTENT_ASSET_CHANGED/);
    assert.equal(publicReads, 3);
});

test('链接允许全空，并能增改删除自定义用途而不恢复旧主页', async () => {
    const empty = { text: key => key, say() {}, multiselect: () => [], select: () => 'linksDone' };
    assert.deepEqual(await marketLinks(sdk, empty, 'en', { homepageUrl: 'https://old.example.org' }), []);
    const actions = ['linkAdd', 'linkEdit', 'linkAdd', 'linkDelete', 'linksDone'];
    const values = ['Guide', 'https://example.org/guide', 'Support', 'https://example.org/help', 'Remove', 'https://example.org/remove'];
    const identities = [];
    const ui = { ...empty, select: key => key === 'linkAction' ? actions.shift() : undefined,
        ask: async (_key, _initial, validate, options) => { const value = values.shift(); identities.push(options.identity); await validate(value); return value; } };
    ui.select = (key, links) => key === 'linkAction' ? actions.shift() : actions[0] === 'linksDone' ? links.at(-1) : links[0];
    assert.deepEqual(await marketLinks(sdk, ui, 'en', { links: [] }), [{ kind: 'custom', label: { en: 'Support' }, url: 'https://example.org/help' }]);
    assert(identities.every(Boolean));
});

test('冻结源码精确提取本版日志，HTML 原文件进入附件并投影到同一版本 Release', async () => {
    const root = fs.mkdtempSync(path.join(sdk.workspace, 'fixed-source-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Log\n## [v8.2.6] - 2031.3.2\n### Features\n- New feature\n## [8.2.5]\n- Old feature\n');
    const html = '<h1>Plugin</h1><p>Read <a href="https://example.org">help</a>.</p><script>bad()</script>';
    fs.writeFileSync(path.join(root, 'README.html'), html);
    const previews = [];
    const ui = { text: key => key, say: (_key, value) => assert.fail(JSON.stringify(value)),
        select: (key, _values, _label, initial) => key === 'contentFormat' ? initial : 'contentRepository',
        ask: (_key, suggestion, validate) => { validate(suggestion); return suggestion; },
        confirm: (key, data) => {
            if (key === 'contentPreview') {
                previews.push(data);
                if (data.purpose === 'releaseNotes') fs.writeFileSync(path.join(root, 'CHANGELOG.md'), 'Changed after snapshot');
            }
            return true;
        } };
    const source = { repository: 'https://github.com/example/plugin', commit: 'a'.repeat(40) };
    const result = await contentFields({ sdk, ui }, root, source, { defaultLocale: 'en' }, { pluginId: 'test', version: '8.2.6' }, '.');
    assert.equal(result.files.size, 3);
    const notes = result.files.get(result.content.releaseNotes.en.asset.name).toString();
    assert(notes.includes('### Features')); assert(!notes.includes('Old feature'));
    assert.equal(result.files.get(result.content.readme.en.asset.name).toString(), html);
    assert.equal(result.content.readme.en.sourceUrl, source.repository + '/blob/' + source.commit + '/README.html');
    assert(result.files.get(result.content.changelog.en.asset.name).toString().includes('Old feature'));
    assert(!result.files.get(result.content.changelog.en.asset.name).toString().includes('Changed after snapshot'));
    assert.equal(previews.length, 3);
    const frozen = fs.mkdtempSync(path.join(sdk.workspace, 'docs-'));
    for (const [name, bytes] of result.files) fs.writeFileSync(path.join(frozen, name), bytes);
    sdk.invoke({ command: 'content', value: result.content, root: frozen, locale: 'en' });
    const original = structuredClone(result.content);
    const catalog = publishedContent(original, 'https://example.org/release/');
    assert.equal(catalog.readme.en.asset.url, 'https://example.org/release/' + original.readme.en.asset.name);
    assert.deepEqual(original, result.content);
    assert.equal(catalog.readme.en.asset.sha256, hash(Buffer.from(html)));
    assert.equal(catalog.readme.en.sourceUrl, result.content.readme.en.sourceUrl);
    fs.appendFileSync(path.join(frozen, result.content.readme.en.asset.name), 'changed');
    assert.throws(() => sdk.invoke({ command: 'content', value: result.content, root: frozen, locale: 'en' }));
});

test('缺失版本必须显式选择跳过；手工多行不被 trim 或压成单行', async () => {
    const root = fs.mkdtempSync(path.join(sdk.workspace, 'missing-version-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Log\n## [Unreleased]\n- pending\n');
    let attempts = 0, missing = 0;
    const manual = '  ## Notes\n\n- First\n- Second\n';
    const ui = { text: key => key, say: key => { assert.equal(key, 'contentMissing'); missing++; },
        select: key => key === 'readmeSource' ? 'contentNone' : attempts++ ? 'contentManual' : 'contentRepository',
        ask: (_key, suggestion) => suggestion,
        multiline: async (_key, _initial, validate) => { await validate(manual); return manual; }, confirm: () => true };
    const result = await contentFields({ sdk, ui }, root, { repository: 'https://github.com/example/plugin', commit: 'b'.repeat(40) },
        { defaultLocale: 'en' }, { pluginId: 'test', version: '8.3.7' }, '.');
    assert.equal(missing, 1);
    assert.equal([...result.files.values()][0].toString(), manual);
    assert(!result.content.changelog); assert(!result.content.readme);
    assert.equal(result.content.releaseNotes.en.sourceUrl, undefined);
});

test('多行返回和会话恢复保留换行，改变链接身份不能重放其它条目的网址', async () => {
    let history;
    const ui = { multiline: () => 'One\n\nTwo\n', ask: () => 'https://example.org/a' };
    const form = async ui => [await ui.multiline('contentInput', '', () => {}),
        await ui.ask('linkUrl', '', () => {}, { identity: 'first', remember: false })];
    const initial = await navigation(ui, () => null, { onChange: values => { history = values; } }).run(form);
    const restored = await navigation({ multiline: () => assert.fail('re-entered'), ask: () => assert.fail('re-entered') },
        () => null, { history }).run(form);
    assert.deepEqual(restored, initial);
    let asked = false;
    const changed = await navigation({ ...ui, ask: () => { asked = true; return 'https://example.org/b'; } }, () => null, { history })
        .run(async ui => [await ui.multiline('contentInput', '', () => {}), await ui.ask('linkUrl', '', () => {}, { identity: 'second', remember: false })]);
    assert(asked); assert.equal(changed[1], 'https://example.org/b');
});

test('文档原始附件必须全部公开回读，缺失和内容变化均失败', async () => {
    const bytes = Buffer.from('# Read me'), name = `content-${hash(bytes)}.md`;
    const assets = [{ id: 21, name, size: bytes.length, digest: `sha256:${hash(bytes)}`, state: 'uploaded' }];
    const directory = () => fs.mkdtempSync(path.join(sdk.workspace, 'readback-'));
    await verifyPublicAssets('author/test-v8.3.7', assets, directory(), (_url, file, maximum, expected) => {
        assert.equal(maximum, bytes.length); assert.equal(expected.sha256, hash(bytes)); fs.writeFileSync(file, bytes);
    });
    await assert.rejects(verifyPublicAssets('author/test-v8.3.7', assets, directory(), (_url, file) => fs.writeFileSync(file, 'bad')), /PUBLICATION_READBACK_FAILED/);
    await assert.rejects(verifyPublicAssets('author/test-v8.3.7', assets, directory(), () => { throw new Error('404'); }), /404/);
    assert.throws(() => verifyCandidateMarket({ files: [{ path: name, size: bytes.length, sha256: hash(bytes) }] },
        { submission: { market: {} } }), /CONTENT_ASSET_CHANGED/);
    assert.equal(publishedImage(undefined, '', undefined), undefined);
});
