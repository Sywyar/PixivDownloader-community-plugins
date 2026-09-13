import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, sha } from './github.mjs';
import { root } from './sdk.mjs';

export const markerName = '.pixivdownloader-plugin-project';
export const markerMissing = '未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录';
export const git = (directory, ...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
    '-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

// 入口预检不写文件、不执行工程脚本、不调用 GitHub；固定 SDK 随后再次完整核验。
export function preflight(directory) {
    const cwd = fs.realpathSync(directory);
    let gitRoot;
    try { gitRoot = fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel')); }
    catch { throw new Error(markerMissing); }
    const records = git(gitRoot, 'ls-files', '--stage', '-z', '--', `:(glob)**/${markerName}`).split('\0').filter(Boolean);
    const candidates = records.map(record => {
        const match = /^(100644|100755) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t(.+)$/u.exec(record);
        if (!match) throw new Error('PROJECT_MARKER_INVALID');
        const relative = path.posix.dirname(match[2]);
        const project = path.resolve(gitRoot, relative);
        const marker = path.join(project, markerName);
        if (!fs.lstatSync(marker).isFile() || fs.realpathSync(marker) !== marker) throw new Error('PROJECT_MARKER_INVALID');
        const maximum = Buffer.byteLength('pixivdownloader-plugin-project-v1', 'utf8') + 5;
        const fd = fs.openSync(marker, 'r');
        const bytes = Buffer.alloc(maximum + 1);
        let count;
        try { count = fs.readSync(fd, bytes); } finally { fs.closeSync(fd); }
        if (count > maximum || !/^(?:\ufeff)?pixivdownloader-plugin-project-v1(?:\r?\n)?$/u.test(bytes.subarray(0, count).toString('utf8'))) {
            throw new Error('PROJECT_MARKER_INVALID');
        }
        return { projectDir: relative, project };
    }).filter(item => item.project === cwd || cwd === gitRoot && item.project.startsWith(gitRoot + path.sep));
    if (!candidates.length) throw new Error(markerMissing);
    return { cwd, gitRoot, candidates };
}

export function sourceFacts(gitRoot) {
    if (git(gitRoot, 'status', '--porcelain=v1', '--untracked-files=normal')) throw new Error('SOURCE_COMMIT_REQUIRED');
    const commit = sha(git(gitRoot, 'rev-parse', 'HEAD'));
    const remote = git(gitRoot, 'remote', 'get-url', 'origin');
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(remote);
    if (!match || match[1].split('/').some(part => ['.', '..'].includes(part))) throw new Error('SOURCE_GITHUB_REMOTE_REQUIRED');
    return { repository: `https://github.com/${match[1]}`, name: match[1], commit, remote };
}

export function runBuild(executable, args, cwd) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PRIVATE_KEY|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS/iu.test(key)));
    const options = { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] };
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/iu.test(executable)) return execFileSync(executable, args, options);
    // PowerShell 读取数据参数；路径和模型命令均不拼进 shell 源码。
    env.PIXIV_BUILD_ARGUMENTS = Buffer.from(JSON.stringify({ executable, args }), 'utf8').toString('base64');
    const script = "$ErrorActionPreference='Stop'; $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
        + '$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIXIV_BUILD_ARGUMENTS))|ConvertFrom-Json; '
        + '$buildArgs=@($v.args); & $v.executable @buildArgs; exit $LASTEXITCODE';
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], options);
}

const scalaString = text => `new String(Array[Byte](${[...Buffer.from(text, 'utf8')].join(',')}),java.nio.charset.StandardCharsets.UTF_8)`;

// 本地向导和容器构建共用模型命令及解析，执行位置和构建工具由各自入口决定。
export function modelArguments(profileId, file, gradleScript) {
    if (profileId === 'maven-java17-v1') {
        return ['-N', 'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom', `-Doutput=${file}`];
    } else if (profileId === 'gradle-java17-v1') {
        return ['--init-script', gradleScript, 'pixivCommunityModel'];
    } else if (profileId === 'sbt-java17-v1') {
        const separator = scalaString('\n');
        const command = 'set commands += Command.command(' + scalaString('pixivCommunityModel') + ') { s => '
            + 'val e=Project.extract(s); val lines=Seq(e.get(version),e.get(Compile / packageBin / artifactPath).getAbsolutePath,e.get(Compile / classDirectory).getAbsolutePath) ++ '
            + 'e.get(libraryDependencies).map(d => Seq(d.organization,d.name,d.revision,d.configurations.getOrElse(' + scalaString('compile')
            + ')).mkString(' + scalaString('\t') + ')); println(' + scalaString('PIXIV_COMMUNITY_MODEL=')
            + '+java.util.Base64.getEncoder.encodeToString(lines.mkString(' + separator + ').getBytes(java.nio.charset.StandardCharsets.UTF_8))); s }';
        return [command, 'pixivCommunityModel'];
    } else throw new Error('BUILD_PROFILE_UNSUPPORTED');
}

export function readModel(sdk, profileId, output, file) {
    if (profileId === 'maven-java17-v1') return sdk.invoke({ command: 'maven-model', file });
    const lines = output.split(/\r?\n/u).filter(line => line.startsWith('PIXIV_COMMUNITY_MODEL='));
    if (lines.length !== 1) throw new Error('BUILD_MODEL_AMBIGUOUS');
    const value = lines[0].slice('PIXIV_COMMUNITY_MODEL='.length);
    if (profileId === 'gradle-java17-v1') return JSON.parse(value);
    if (profileId !== 'sbt-java17-v1') throw new Error('BUILD_PROFILE_UNSUPPORTED');
    const [version, artifact, classes, ...dependencies] = Buffer.from(value, 'base64').toString('utf8').split('\n');
    return { version, artifacts: [artifact], classDirectories: [classes], dependencies: dependencies.map(line => {
        const [group, name, version, scope] = line.split('\t'); return { group, name, version, scope };
    }) };
}

export function queryModel(sdk, selection, profileId, run = runBuild) {
    const project = selection.project;
    const commands = {
        'maven-java17-v1': ['mvnw', 'mvnw.cmd', 'mvn', 'mvn.cmd'],
        'gradle-java17-v1': ['gradlew', 'gradlew.bat'],
        'sbt-java17-v1': ['sbtw', 'sbtw.cmd', 'sbt', 'sbt.bat'],
    }[profileId];
    if (!commands) throw new Error('BUILD_PROFILE_UNSUPPORTED');
    const platform = process.platform === 'win32' ? 1 : 0;
    let executable = path.join(project, commands[platform]);
    if (!fs.existsSync(executable) && commands[platform + 2]) executable = commands[platform + 2];
    const file = path.join(sdk.workspace, 'effective-pom.xml');
    const options = profileId === 'maven-java17-v1' ? ['-B', '-ntp']
        : profileId === 'gradle-java17-v1' ? ['--no-daemon', '--console=plain', '--no-configuration-cache'] : [];
    const args = [...options, ...modelArguments(profileId, file, path.join(root, 'tools/community-model.gradle'))];
    const model = readModel(sdk, profileId, run(executable, args, project), file);
    if (typeof model.version !== 'string' || !model.version || !Array.isArray(model.artifacts) || !model.artifacts.length) {
        throw new Error('BUILD_MODEL_INVALID');
    }
    const artifacts = [...new Set(model.artifacts.map(file => path.relative(project, file).split(path.sep).join('/')))];
    for (const artifact of artifacts) sdk.invoke({ command: 'path', root: project, path: artifact, mustExist: true });
    return { ...model, artifacts, command: { executable, args } };
}
