import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { API_BYTES, main } from './github.mjs';
import { observe } from './submission-progress.mjs';
import { checkJavaTools, runTool, toolJson } from './tool-process.mjs';
import { buildCommunityTools } from './community-tools.mjs';
import { fileMatches, plainPath } from './foundation-resources.mjs';
export { foundationResource as sdkResource } from './foundation-resources.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function prepareSdk(directory = root) {
    const prepared = prepareSdkRuntime(directory);
    try {
        prepared.invoke('verify');
        return prepared;
    } catch (error) {
        plainPath(prepared.workspace);
        fs.rmSync(prepared.workspace, { recursive: true });
        throw error;
    }
}

function prepareSdkRuntime(directory = root) {
    observe('checkingJava', '', () => checkJavaTools());
    const built = observe('verifyingTools', '', () => buildCommunityTools(directory));
    const target = path.join(directory, 'target');
    plainPath(target);
    const workspace = fs.mkdtempSync(path.join(target, 'community-'));
    try {
        fs.mkdirSync(path.join(workspace, 'tools'));
        const jar = path.join(workspace, 'tools', built.tool.path);
        fs.copyFileSync(built.jar, jar);
        for (const name of ['build-model.mjs', 'community-model.gradle']) fs.copyFileSync(
            path.join(built.foundation.directory, 'tools', name), path.join(workspace, 'tools', name));
        fs.cpSync(path.join(built.foundation.directory, 'resources/community/v1'),
            path.join(workspace, 'contracts/community/v1'), { recursive: true });
        const classes = path.join(workspace, 'runtime');
        fs.mkdirSync(classes);
        const classpath = [jar, ...built.libraries, classes].join(path.delimiter);
        // 每次执行重验实际字节；不把投稿代码加入 classpath。
        const run = (command, args, cwd = workspace, input) => observe('tool_' + command, '', () => {
            if (!fileMatches(jar, built.tool)) throw new Error('COMMUNITY_TOOL_MISSING');
            for (let i = 0; i < built.libraries.length; i++) {
                if (!fileMatches(built.libraries[i], built.foundation.lock.libraries[i])) throw new Error('FOUNDATION_RESOURCE_MISSING');
            }
            return runTool(command, command === 'java'
                ? ['-Xlog:all=off:stdout', '-Xlog:all=warning:stderr', ...args] : args, { cwd, input }).stdout;
        });
        const invoke = command => observe('checkingContract', '', () => toolJson(run('java',
            ['-cp', classpath, 'CommunityReview', workspace, built.identity.sourceSha256, command])));
        return { workspace, invoke, run, classpath, resources: built.foundation.directory,
            toolIdentity: built.identity };
    } catch (error) {
        plainPath(workspace);
        fs.rmSync(workspace, { recursive: true });
        throw error;
    }
}

export function evidence(workspace, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (bytes.length > API_BYTES) throw new Error('EVIDENCE_SIZE_EXCEEDED');
    const digest = hash(bytes);
    const relative = `reviews/evidence/${digest}.json`;
    fs.mkdirSync(path.join(workspace, 'reviews/evidence'), { recursive: true });
    fs.writeFileSync(path.join(workspace, relative), bytes);
    return { path: relative, size: bytes.length, sha256: digest };
}

export function evaluate(prepared, input) {
    const bytes = Buffer.from(JSON.stringify(input), 'utf8');
    if (bytes.length > API_BYTES) throw new Error('EVIDENCE_SIZE_EXCEEDED');
    fs.writeFileSync(path.join(prepared.workspace, 'input.json'), bytes);
    return (prepared.reviewInvoke ?? prepared.invoke)('review');
}

export function readDecisionArtifact(prepared, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > API_BYTES) throw new Error('ARTIFACT_SIZE_EXCEEDED');
    fs.writeFileSync(path.join(prepared.workspace, 'artifact.zip'), bytes);
    return Buffer.from((prepared.reviewInvoke ?? prepared.invoke)('artifact'), 'base64');
}

main(import.meta.url, () => {
    if (process.argv.length !== 2) throw new Error('USAGE: sdk.mjs');
    console.log(JSON.stringify(prepareSdk().invoke('verify')));
});
