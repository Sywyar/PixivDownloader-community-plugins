import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { root, hash } from './sdk.mjs';
import { git } from './project.mjs';

export function signingTool(sdk) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'tools/signing-tool.json'), 'utf8'));
    if (lock.schemaVersion !== 1 || lock.sourceRepository !== 'https://github.com/Sywyar/PixivDownloader'
        || !/^[a-f0-9]{40}$/u.test(lock.sourceCommit) || lock.path !== 'tools/signing-tool.jar') throw new Error('SIGNING_TOOL_LOCK_INVALID');
    const source = path.join(root, lock.path);
    if (!fs.lstatSync(source).isFile() || fs.statSync(source).size !== lock.size) throw new Error('SIGNING_TOOL_CHANGED');
    const bytes = fs.readFileSync(source);
    if (bytes.length !== lock.size || hash(bytes) !== lock.sha256) throw new Error('SIGNING_TOOL_CHANGED');
    const jar = path.join(sdk.workspace, 'signing-tool.jar');
    fs.writeFileSync(jar, bytes, { flag: 'wx' });
    return (...args) => sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', jar,
        'top.sywyar.pixivdownload.plugin.signature.cli.PluginSignatureTool', ...args]);
}

export function keyLocation(requested, projectRoot, newDirectory = false) {
    const file = path.resolve(requested);
    const parent = newDirectory ? path.dirname(file) : file;
    if (fs.realpathSync(parent) !== parent || !newDirectory && !fs.lstatSync(file).isFile()) throw new Error('KEY_PATH_INVALID');
    for (const directory of [projectRoot, root, os.tmpdir()]) {
        const relative = path.relative(fs.realpathSync(directory), file);
        if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('KEY_OUTSIDE_PROJECT_AND_TEMP_REQUIRED');
    }
    let repository = null;
    try { repository = git(newDirectory ? parent : path.dirname(file), 'rev-parse', '--show-toplevel'); } catch { /* 不在 Git 工程中。 */ }
    if (repository) throw new Error('KEY_OUTSIDE_PROJECT_AND_TEMP_REQUIRED');
    if (newDirectory ? fs.existsSync(file) : fs.statSync(file).size > 16 * 1024) throw new Error('KEY_PATH_INVALID');
    return file;
}

export function exportKey(sdk, sign, publicFile, keyId) {
    const output = path.join(sdk.workspace, crypto.randomUUID() + '.public.json');
    sign('public-key', '--public-key', publicFile, '--key-id', keyId, '--out', output);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
}

export function signOperation(sdk, sign, kind, request, proofs) {
    const placeholder = keyId => ({ formatVersion: 1, algorithm: 'Ed25519', keyId, value: Buffer.alloc(64).toString('base64') });
    request.requestId = '0'.repeat(64);
    request.proofs = Object.fromEntries(Object.entries(proofs).map(([name, key]) => [name, placeholder(key.keyId)]));
    request.requestId = sdk.invoke({ command: 'canonical', kind, file: sdk.save(request) }).requestId;
    const operation = { ROTATION: 'PUBLISHER_KEY_ROTATION', STATUS_REQUEST: 'VERSION_STATUS_REQUEST', TRANSFER: 'OWNERSHIP_TRANSFER' }[kind];
    for (const [name, key] of Object.entries(proofs)) {
        const output = path.join(sdk.workspace, crypto.randomUUID() + '.signature.json');
        sign('community-operation', '--operation', operation, '--canonical-body', path.join(sdk.workspace, 'canonical.bin'),
            '--request-id', request.requestId, '--key-id', key.keyId, '--private-key', key.privateFile, '--out', output);
        request.proofs[name] = JSON.parse(fs.readFileSync(output, 'utf8'));
    }
    return request;
}
