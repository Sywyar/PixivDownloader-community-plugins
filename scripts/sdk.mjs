import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { API_BYTES, main, sha } from './github.mjs';
import { observe } from './submission-progress.mjs';
import { checkJavaTools, runTool, toolJson } from './tool-process.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function verifyTool(directory = root) {
    const lock = JSON.parse(fs.readFileSync(path.join(directory, 'tools/sdk-lock.json'), 'utf8'));
    const metadataBytes = fs.readFileSync(path.join(directory, 'tools/community-contract.json'));
    if (hash(metadataBytes) !== lock.metadataSha256) throw new Error('SDK_METADATA_HASH_MISMATCH');
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    if (metadata.sourceCommit !== sha(lock.sourceCommit) || metadata.tool.path !== 'tools/sdk-tools.jar') throw new Error('SDK_SOURCE_MISMATCH');
    const tool = path.join(directory, metadata.tool.path);
    if (!fs.lstatSync(tool).isFile() || fs.statSync(tool).size !== metadata.tool.size
        || hash(fs.readFileSync(tool)) !== metadata.tool.sha256) throw new Error('SDK_TOOL_HASH_MISMATCH');
    return { lock, metadata };
}

export function prepareSdk(directory = root) {
    observe('checkingJava', '', () => checkJavaTools());
    const { lock } = observe('verifyingTools', '', () => verifyTool(directory));
    const target = path.join(directory, 'target');
    fs.mkdirSync(target, { recursive: true });
    if (!fs.lstatSync(target).isDirectory()) throw new Error('SDK_WORKSPACE_INVALID');
    const workspace = fs.mkdtempSync(path.join(target, 'community-'));
    fs.mkdirSync(path.join(workspace, 'tools'));
    for (const name of ['sdk-tools.jar', 'community-contract.json']) fs.copyFileSync(path.join(directory, 'tools', name), path.join(workspace, 'tools', name));
    fs.cpSync(path.join(directory, 'schemas/community/v1'), path.join(workspace, 'contracts/community/v1'), { recursive: true });
    const classes = path.join(workspace, 'runtime');
    fs.mkdirSync(classes);
    // JVM 默认将统一日志写入 stdout；合同 JSON 独占 stdout，诊断转入 stderr。
    const run = (command, args, cwd = workspace, input) => observe('tool_' + command, '', () => runTool(command,
        command === 'java' ? ['-Xlog:all=off:stdout', '-Xlog:all=warning:stderr', ...args] : args, {
        cwd, input,
    }).stdout);
    run('jar', ['--extract', '--file', path.join(workspace, 'tools/sdk-tools.jar'), 'BOOT-INF/classes', 'BOOT-INF/lib'], classes);
    const classpath = [path.join(classes, 'BOOT-INF/classes'), path.join(classes, 'BOOT-INF/lib/*'), classes].join(path.delimiter);
    run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', classpath, '-d', classes, path.join(directory, 'tools/CommunityReview.java')]);
    const invoke = command => observe('checkingContract', '', () => toolJson(run('java', ['-cp', classpath, 'CommunityReview', workspace, lock.sourceCommit, command])));
    invoke('verify');
    return { workspace, invoke, run, classpath };
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
