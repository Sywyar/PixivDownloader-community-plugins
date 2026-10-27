import fs from 'node:fs';
import path from 'node:path';
import { buildCommunityTools } from './community-tools.mjs';
import { download } from './download.mjs';
import { fileMatches, plainPath, resourceRoot } from './foundation-resources.mjs';
import { runTool } from './tool-process.mjs';

// 测试依赖不进入生产 classpath；公开 Central 原始字节由此处固定。
const dependencies = [
    { path: 'org/junit/platform/junit-platform-console-standalone/1.12.2/junit-platform-console-standalone-1.12.2.jar',
        size: 2950047, sha256: '329bd10288875a74d04c9ca6b7c9889c265ddf87b21a9ea42a7f7392f391472a' },
    { path: 'org/assertj/assertj-core/3.27.3/assertj-core-3.27.3.jar',
        size: 1396119, sha256: '5b8a26205f6d5ea60ad9ce65ce4a40a2afe4c48abeec61bd0740a088c24e89f5' },
];

const built = buildCommunityTools();
const directory = fs.mkdtempSync(path.join(resourceRoot, 'target/governance-tests-'));
try {
    const libraries = [];
    for (const entry of dependencies) {
        const file = path.join(directory, path.posix.basename(entry.path));
        await download('https://repo.maven.apache.org/maven2/' + entry.path, file, entry.size, entry);
        if (!fileMatches(file, entry)) throw new Error('TEST_DEPENDENCY_MISSING');
        libraries.push(file);
    }
    const classes = path.join(directory, 'classes');
    fs.mkdirSync(classes);
    const sourceRoot = path.join(resourceRoot, 'tools/governance/src/test/java');
    const sources = fs.readdirSync(sourceRoot, { recursive: true }).filter(name => name.endsWith('.java'))
        .map(name => path.join(sourceRoot, name));
    const argumentsFile = path.join(directory, 'sources.txt');
    fs.writeFileSync(argumentsFile, sources.map(file => '"' + file.replaceAll('\\', '/') + '"').join('\n'), 'utf8');
    const classpath = [built.jar, ...built.libraries, ...libraries, classes].join(path.delimiter);
    runTool('javac', ['--release', '17', '-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', classes, '@' + argumentsFile]);
    const result = runTool('java', ['-Dfile.encoding=UTF-8', '-cp', classpath, 'org.junit.platform.console.ConsoleLauncher',
        'execute', '--scan-class-path=' + classes, '--fail-if-no-tests', '--disable-ansi-colors', '--details=summary'], { timeout: 120000 });
    console.log(result.stdout);
} catch (error) {
    console.error(error.message);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
} finally {
    plainPath(directory);
    fs.rmSync(directory, { recursive: true });
}
