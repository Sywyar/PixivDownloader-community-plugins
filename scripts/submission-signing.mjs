import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { root, hash } from './sdk.mjs';
import { git } from './project.mjs';
import { readFile } from './submission-fields.mjs';

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
    const passwords = new Map();
    const sign = (...args) => {
        const privateIndex = args.indexOf('--private-key');
        const directoryIndex = args.indexOf('--directory');
        const file = privateIndex >= 0 ? args[privateIndex + 1] : directoryIndex >= 0 ? path.join(args[directoryIndex + 1], 'private-key.pem') : null;
        const password = passwords.get(file);
        return sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', jar,
            'top.sywyar.pixivdownload.plugin.signature.cli.PluginSignatureTool', ...args,
            ...(password ? ['--password-stdin', 'true'] : [])], sdk.workspace, password);
    };
    sign.password = (file, value) => {
        passwords.get(file)?.fill(0);
        if (value === undefined) passwords.delete(file);
        else passwords.set(file, Buffer.from(value, 'utf8'));
    };
    sign.close = () => { passwords.forEach(value => value.fill(0)); passwords.clear(); };
    return sign;
}

export function keyLocation(requested, projectRoot, newDirectory = false) {
    const file = path.resolve(requested);
    const parent = newDirectory ? path.dirname(file) : file;
    try {
        if (path.relative(fs.realpathSync(parent), parent)) throw new Error('KEY_PATH_LINK_REJECTED');
        if (newDirectory ? !fs.lstatSync(parent).isDirectory() : !fs.lstatSync(file).isFile()) throw new Error(newDirectory ? 'KEY_DIRECTORY_REQUIRED' : 'REGULAR_FILE_REQUIRED');
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(newDirectory ? 'KEY_DIRECTORY_PARENT_REQUIRED' : 'KEY_PATH_NOT_FOUND');
        if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('KEY_ACCESS_DENIED');
        throw error;
    }
    for (const directory of [projectRoot, root, os.tmpdir()]) {
        const relative = path.relative(fs.realpathSync(directory), file);
        if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('KEY_OUTSIDE_PROJECT_AND_TEMP_REQUIRED');
    }
    let repository = null;
    try { repository = git(newDirectory ? parent : path.dirname(file), 'rev-parse', '--show-toplevel'); } catch { /* 不在 Git 工程中。 */ }
    if (repository) throw new Error('KEY_OUTSIDE_PROJECT_AND_TEMP_REQUIRED');
    if (newDirectory ? fs.existsSync(file) : fs.statSync(file).size > 16 * 1024) throw new Error(newDirectory ? 'KEY_DIRECTORY_EXISTS' : 'INPUT_LIMIT_EXCEEDED');
    return file;
}

export function keyDirectory(parent, projectRoot) {
    const directory = path.resolve(parent);
    try {
        if (!fs.lstatSync(directory).isDirectory()) throw new Error('KEY_DIRECTORY_REQUIRED');
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('KEY_DIRECTORY_PARENT_REQUIRED');
        if (['EACCES', 'EPERM'].includes(error.code)) throw new Error('KEY_ACCESS_DENIED');
        throw error;
    }
    return keyLocation(path.join(directory, 'publisher-' + crypto.randomUUID()), projectRoot, true);
}

export async function unlockPrivateKey(context, privateFile, publicFile) {
    const { sign, ui } = context;
    const check = () => sign('check-key', '--private-key', privateFile, '--public-key', publicFile);
    if (readFile(privateFile, 16 * 1024).subarray(0, 64).toString('ascii').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
        try { check(); return; } catch { /* 密码只留在当前签名会话，重新输入不会写入工程历史。 */ }
        await ui.password('password', value => {
            if (Buffer.byteLength(value, 'utf8') > 4096) throw new Error('INPUT_SIZE_EXCEEDED');
            sign.password(privateFile, value);
            try { check(); } catch (error) { sign.password(privateFile, undefined); throw error; }
        });
    } else check();
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
