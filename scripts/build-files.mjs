import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { API_BYTES } from './github.mjs';

// 原生缓存支持任意制品扩展名；可变锁与下载状态不是依赖内容。
export function dependencyContent(file) {
    const name = path.posix.basename(file);
    if (name.startsWith('.') || /(?:\.lock|\.lastUpdated)$/u.test(name)
        || ['_remote.repositories', 'resolver-status.properties'].includes(name)) return false;
    return /\.(?:jar|pom|module|xml)$/u.test(file) || file.startsWith('.m2/repository/')
        || file.startsWith('.cache/coursier/') || /^\.gradle\/caches\/modules-[^/]+\/files-[^/]+\//u.test(file)
        || /^\.ivy2\/cache\/[^/]+\/[^/]+\//u.test(file);
}

// 容器结束后读取实际普通文件；链接与特殊文件不能让清点逃离本次文件系统。
export async function fileSnapshot(directory, maximumBytes, include = () => true) {
    const files = [];
    let total = 0;
    let reportBytes = 2;
    async function visit(current, relative) {
        for (const name of fs.readdirSync(current).sort()) {
            const file = path.join(current, name);
            const entry = relative ? `${relative}/${name}` : name;
            const stat = fs.lstatSync(file);
            if (stat.isDirectory()) await visit(file, entry);
            else if (!stat.isFile()) throw new Error('BUILD_FILE_NOT_REGULAR');
            else if (include(entry)) {
                const digest = crypto.createHash('sha256');
                let size = 0;
                for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW })) {
                    size += bytes.length;
                    total += bytes.length;
                    if (total > maximumBytes) throw new Error('BUILD_FILES_SIZE_EXCEEDED');
                    digest.update(bytes);
                }
                const value = { path: entry, size, sha256: digest.digest('hex') };
                reportBytes += Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
                if (reportBytes > API_BYTES) throw new Error('BUILD_FILES_REPORT_EXCEEDED');
                files.push(value);
            }
        }
    }
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('BUILD_FILES_ROOT_INVALID');
    await visit(directory, '');
    return files;
}

export function fileDifference(before, after) {
    const previous = new Map(before.map(file => [file.path, file]));
    const current = new Map(after.map(file => [file.path, file]));
    return {
        added: after.filter(file => !previous.has(file.path)),
        changed: after.filter(file => previous.has(file.path) && previous.get(file.path).sha256 !== file.sha256),
        removed: before.filter(file => !current.has(file.path)),
    };
}
