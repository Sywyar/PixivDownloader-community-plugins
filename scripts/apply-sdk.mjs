import fs from 'node:fs';
import path from 'node:path';
import { root, hash } from './sdk.mjs';
import { API_BYTES } from './github.mjs';

export function applySdk(sdk, directory = root) {
    sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', sdk.classpath, '-d', path.join(sdk.workspace, 'runtime'),
        path.join(directory, 'tools/CommunityApply.java')]);
    const workspace = fs.mkdtempSync(path.join(sdk.workspace, 'apply-'));
    const records = new Map();
    const archive = (value, name) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) + '\n', 'utf8');
        const file = name ?? `records/${hash(bytes)}.json`;
        const ref = { path: file, size: bytes.length, sha256: hash(bytes) };
        if (records.has(file) && records.get(file).sha256 !== ref.sha256) throw new Error('APPLY_EVIDENCE_CONFLICT');
        if (!records.has(file) && [...records.values()].reduce((sum, ref) => sum + ref.size, bytes.length) > API_BYTES) throw new Error('APPLY_EVIDENCE_BUDGET');
        const target = sdk.invoke({ command: 'path', root: workspace, path: file, mustExist: false }).path;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) throw new Error('APPLY_EVIDENCE_CONFLICT');
        if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
        records.set(file, ref);
        return ref;
    };
    const invoke = (input, privateBytes) => {
        const bytes = Buffer.from(JSON.stringify({ ...input, evidence: [...records.values()] }), 'utf8');
        if (bytes.length > API_BYTES) throw new Error('APPLY_INPUT_BUDGET');
        fs.writeFileSync(path.join(workspace, 'apply-input.json'), bytes);
        return JSON.parse(sdk.run('java', ['-Dfile.encoding=UTF-8', '-cp', sdk.classpath, 'CommunityApply', workspace], workspace, privateBytes));
    };
    return { workspace, archive, invoke, records, evidence: ref => ref };
}
