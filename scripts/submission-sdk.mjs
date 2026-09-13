import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareSdk, root } from './sdk.mjs';
import { API_BYTES } from './github.mjs';

// 执行器只调用受保护的适配器；投稿包从不进入 JVM classpath。
export function prepareSubmission(directory = root) {
    const sdk = prepareSdk(directory);
    sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', sdk.classpath,
        '-d', path.join(sdk.workspace, 'runtime'), ...['CommunitySubmission.java', 'CommunitySource.java', 'CommunityModel.java']
            .map(name => path.join(directory, 'tools', name))]);
    const inputFile = path.join(sdk.workspace, 'submission-input.json');
    const invoke = input => {
        const bytes = Buffer.from(JSON.stringify(input), 'utf8');
        if (bytes.length > API_BYTES) throw new Error('INPUT_SIZE_EXCEEDED');
        fs.writeFileSync(inputFile, bytes);
        return JSON.parse(sdk.run('java', ['-Dfile.encoding=UTF-8', '-Djava.awt.headless=true',
            '-cp', sdk.classpath, 'CommunitySubmission', sdk.workspace]).trim());
    };
    const save = (bytes, suffix = '.json') => {
        if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(JSON.stringify(bytes), 'utf8');
        if (bytes.length > API_BYTES) throw new Error('INPUT_SIZE_EXCEEDED');
        const file = path.join(sdk.workspace, crypto.randomUUID() + suffix);
        fs.writeFileSync(file, bytes, { flag: 'wx' });
        return file;
    };
    const document = (kind, bytes, relative) => invoke({ command: 'document', kind, file: save(bytes), path: relative });
    return { ...sdk, reviewInvoke: sdk.invoke, invoke, save, document };
}
