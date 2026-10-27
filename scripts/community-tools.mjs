import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ensureFoundation, fileMatches, plainPath, resourceRoot } from './foundation-resources.mjs';
import { checkJavaTools, runTool } from './tool-process.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const adapters = ['CommunityReview.java', 'CommunitySubmission.java', 'CommunitySource.java', 'CommunityApply.java', 'CommunityScan.java'];
const timestamp = '2020-01-01T00:00:00Z';
let cached;

export function governanceSources(directory = resourceRoot) {
    const files = [];
    const visit = relative => {
        const absolute = path.join(directory, relative);
        plainPath(absolute);
        if (fs.lstatSync(absolute).isDirectory()) {
            for (const name of fs.readdirSync(absolute).sort()) visit(path.posix.join(relative, name));
        } else if (relative.endsWith('.java') && fs.lstatSync(absolute).isFile()) files.push(relative);
        else throw new Error('COMMUNITY_SOURCE_INVALID');
    };
    visit('tools/governance/src/main/java');
    return [...files, ...adapters.map(name => 'tools/' + name)].sort();
}

export function toolIdentity(directory = resourceRoot, foundation = ensureFoundation(directory)) {
    const file = path.join(directory, 'tools/governance/version.json');
    plainPath(file);
    if (fs.statSync(file).size > 1024) throw new Error('COMMUNITY_VERSION_INVALID');
    const version = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (version.schemaVersion !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version.version)) {
        throw new Error('COMMUNITY_VERSION_INVALID');
    }
    let total = 0;
    const sources = [...governanceSources(directory), 'tools/governance/version.json', 'scripts/community-tools.mjs']
        .map(relative => {
            const source = path.join(directory, relative);
            plainPath(source);
            if (!fs.lstatSync(source).isFile() || (total += fs.statSync(source).size) > 32 * 1024 * 1024) {
                throw new Error('COMMUNITY_SOURCE_INVALID');
            }
            return { path: relative, sha256: hash(fs.readFileSync(source)) };
        });
    return { schemaVersion: 1, version: version.version, foundationSha256: foundation.lock.sha256,
        sourceSha256: hash(Buffer.from(JSON.stringify({ foundation: foundation.lock.sha256, sources }))) };
}

export function buildCommunityTools(directory = resourceRoot) {
    checkJavaTools();
    const foundation = ensureFoundation(directory), identity = toolIdentity(directory, foundation);
    if (cached?.identity.sourceSha256 === identity.sourceSha256 && fileMatches(cached.jar, cached.tool)) return cached;
    const target = path.join(directory, 'target');
    plainPath(target);
    fs.mkdirSync(target, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(target, 'community-build-'));
    const classes = path.join(workspace, 'classes');
    fs.mkdirSync(classes);
    try {
        fs.cpSync(path.join(foundation.directory, 'resources'), classes, { recursive: true });
        const sources = [...foundation.lock.files.filter(file => file.target.startsWith('src/'))
            .map(file => path.join(foundation.directory, file.target)),
        ...governanceSources(directory).map(file => path.join(directory, file))];
        const argumentsFile = path.join(workspace, 'sources.txt');
        fs.writeFileSync(argumentsFile, sources.map(file => '"' + file.replaceAll('\\', '/') + '"').join('\n'), 'utf8');
        const libraries = foundation.lock.libraries.map(file => path.join(foundation.directory, 'lib', path.posix.basename(file.path)));
        runTool('javac', ['--release', '17', '-encoding', 'UTF-8', '-proc:none', '-cp', libraries.join(path.delimiter),
            '-d', classes, '@' + argumentsFile]);
        fs.mkdirSync(path.join(classes, 'META-INF'), { recursive: true });
        fs.writeFileSync(path.join(classes, 'META-INF/community-tools.json'), JSON.stringify(identity) + '\n', 'utf8');
        const jar = path.join(workspace, `community-tools-${identity.version}.jar`);
        runTool('jar', ['--create', '--file', jar, '--date', timestamp, '-C', classes, '.']);
        const bytes = fs.readFileSync(jar);
        const tool = { path: path.basename(jar), size: bytes.length, sha256: hash(bytes) };
        // 只复用本进程从已验证源码构建的字节；磁盘自报摘要不能建立信任。
        if (cached) { plainPath(cached.workspace); fs.rmSync(cached.workspace, { recursive: true }); }
        cached = { workspace, jar, tool, identity, libraries, foundation };
        return cached;
    } catch (error) {
        plainPath(workspace);
        fs.rmSync(workspace, { recursive: true });
        throw error;
    }
}

process.once('exit', () => {
    if (cached) { plainPath(cached.workspace); fs.rmSync(cached.workspace, { recursive: true }); }
});

export function packageCommunityTools(output, directory = resourceRoot) {
    const built = buildCommunityTools(directory);
    plainPath(output);
    fs.mkdirSync(output);
    fs.mkdirSync(path.join(output, 'lib'));
    fs.copyFileSync(built.jar, path.join(output, built.tool.path));
    for (const file of built.libraries) fs.copyFileSync(file, path.join(output, 'lib', path.basename(file)));
    const manifest = { ...built.identity, tool: built.tool,
        libraries: built.foundation.lock.libraries.map(file => ({ path: 'lib/' + path.posix.basename(file.path), size: file.size, sha256: file.sha256 })) };
    // 同包提供实际编译源码与许可证；技术源码继续由固定上游维护。
    const source = path.join(output, 'source');
    for (const relative of [...governanceSources(directory), 'tools/governance/version.json', 'tools/foundation-lock.json', 'LICENSE']) {
        const destination = path.join(source, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(directory, relative), destination);
    }
    for (const entry of built.foundation.lock.files) {
        const destination = path.join(source, 'foundation', entry.target);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(built.foundation.directory, entry.target), destination);
    }
    fs.copyFileSync(path.join(directory, 'LICENSE'), path.join(output, 'LICENSE'));
    // 构建配方与运行源按同一渠道清单交付，重新构建仍核对固定依赖。
    const runtime = JSON.parse(fs.readFileSync(path.join(directory, 'tools/submission-files.json'), 'utf8'));
    for (const entry of runtime.files.filter(file => file.path.startsWith('scripts/'))) {
        const destination = path.join(source, entry.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(directory, entry.path), destination);
    }
    fs.copyFileSync(path.join(directory, 'tools/submission-files.json'), path.join(source, 'tools/submission-files.json'));
    fs.writeFileSync(path.join(output, 'community-tools.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 3) throw new Error('USAGE: community-tools.mjs output-directory');
        console.log(JSON.stringify(packageCommunityTools(path.resolve(process.argv[2]))));
    } catch (error) {
        console.error(error.message);
        if (error.stderr) console.error(error.stderr);
        process.exitCode = 1;
    }
}
