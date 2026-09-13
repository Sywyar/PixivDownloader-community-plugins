import { setTimeout } from 'node:timers/promises';
import { terminal } from './submission-ui.mjs';
import { httpsUrl } from './download.mjs';

// 仅演示真实交互组件；不调用账号、签名、构建或投稿写入流程。
let ui;
try {
    ui = await terminal();
    ui.say('demo');
    const operation = await ui.select('operation', ['publish', 'YANK', 'UNYANK', 'REVOKE', 'transfer'], key => ui.text(key));
    const project = await ui.select('project', ['example-minimal', 'example-gallery', 'example-download']);
    const profile = await ui.select('profile', ['Maven', 'Gradle', 'sbt']);
    if (!await ui.confirm('trust', { project, profile, preview: true })) throw new Error('CANCELLED');
    await ui.task('model', () => setTimeout(600));
    const name = await ui.ask('name', 'Example plugin');
    const summary = await ui.ask('summary');
    const category = await ui.select('category', ['DOWNLOAD', 'GALLERY', 'UTILITY']);
    const tags = await ui.multiselect('tags', ['automation', 'images', 'metadata', 'organization', 'tools']);
    const url = await ui.ask('packageUrl', 'https://example.org/plugin.jar', value => { httpsUrl(value); });
    await ui.task('validating', () => setTimeout(600));
    const confirmed = await ui.confirm('preview', {
        title: `${operation}: ${name}`, repository: 'example/community-plugins',
        actor: { login: 'example-author', id: '101' }, fork: { name: 'example-author/community-plugins', create: false },
        base: 'a'.repeat(40), branch: 'community/preview/example',
        result: { operation, project, profile, name, summary, category, tags, url },
        files: [{ path: 'submissions/101/example-plugin/1.0.0.json', size: 128, sha256: 'b'.repeat(64), content: '{"preview":true}' }],
        actions: ['CREATE_COMMIT', 'PUSH_BRANCH', 'CREATE_READY_PR'],
    });
    ui.say(confirmed ? 'demoFinished' : 'cancelled');
} catch (error) {
    if (error.message === 'CANCELLED') ui?.say('cancelled');
    else { console.error(error.message); process.exitCode = 1; }
} finally { ui?.close(); }
