import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { download } from './download.mjs';
import { API_BYTES, API_TIMEOUT } from './github.mjs';
import { root } from './sdk.mjs';
import { buildPolicy } from './build-sandbox.mjs';

// 构建只接收实际使用的工具身份；扫描器升级不改变构建输入。
export function buildToolchain(sdk) {
    const { toolchain } = JSON.parse(fs.readFileSync(path.join(sdk.workspace, 'contracts/community/v1/bundle-manifest.json'), 'utf8'));
    const { maven, gradle, sbt } = toolchain;
    return { maven, gradle, sbt };
}

// 工具版本来自已核验的 SDK 清单；下载和解包均发生在执行投稿代码之前。
export async function prepareBuildTools(sdk, directory, fetch = download) {
    const toolchain = buildToolchain(sdk);
    const { maven, gradle, sbt } = toolchain;
    const node = buildPolicy.node;
    const inputs = [
        { name: 'maven', ...maven, url: `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${maven.version}/apache-maven-${maven.version}-bin.zip`,
            archive: 'maven.zip', folder: `apache-maven-${maven.version}` },
        { name: 'gradle', ...gradle, url: `https://services.gradle.org/distributions/gradle-${gradle.version}-bin.zip`,
            archive: 'gradle.zip', folder: `gradle-${gradle.version}` },
        { name: 'sbt', ...sbt, url: `https://repo.maven.apache.org/maven2/org/scala-sbt/sbt-launch/${sbt.version}/sbt-launch-${sbt.version}.jar`, archive: 'sbt-launch.jar' },
        { name: 'node', ...node, url: `https://nodejs.org/dist/v${node.version}/node-v${node.version}-linux-x64.tar.xz`,
            archive: 'node.tar.xz', folder: `node-v${node.version}-linux-x64` },
    ];
    fs.mkdirSync(directory);
    const maximum = sdk.invoke({ command: 'limits' }).maxArchiveBytes;
    for (const input of inputs) {
        if (!/^\d+(?:\.\d+){1,2}$/u.test(input.version) || !/^[a-f0-9]{64}$/u.test(input.sha256)) throw new Error('BUILD_TOOL_IDENTITY_INVALID');
        const file = path.join(directory, input.archive);
        const actual = await fetch(input.url, file, maximum);
        if (actual.sha256 !== input.sha256) throw new Error('BUILD_TOOL_DIGEST_MISMATCH');
        input.size = actual.size;
        if (input.folder) {
            const command = input.archive.endsWith('.zip') ? 'unzip' : 'tar';
            const args = command === 'unzip' ? ['-q', file, '-d', directory] : ['-xJf', file, '-C', directory];
            execFileSync(command, args, { timeout: API_TIMEOUT, maxBuffer: API_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
            fs.renameSync(path.join(directory, input.folder), path.join(directory, input.name));
        }
    }
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'tools'));
    for (const name of ['project.mjs', 'sdk.mjs', 'github.mjs', 'repository-policy.json', 'build-profile.mjs']) {
        fs.copyFileSync(path.join(root, 'scripts', name), path.join(directory, 'scripts', name));
    }
    fs.copyFileSync(path.join(root, 'tools/community-model.gradle'), path.join(directory, 'tools/community-model.gradle'));
    fs.writeFileSync(path.join(directory, 'toolchain.json'), JSON.stringify(toolchain), 'utf8');
    fs.writeFileSync(path.join(directory, 'sbt-repositories'), '[repositories]\ncentral: https://repo.maven.apache.org/maven2/\n', 'utf8');
    return inputs.map(({ name, version, url, size, sha256 }) => ({ name, version, url, size, sha256 }));
}
