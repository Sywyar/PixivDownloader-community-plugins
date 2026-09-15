import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { modelArguments } from '../tools/build-model.mjs';
import { API_BYTES, main } from './github.mjs';

/** 此入口只在无凭据的构建容器内执行；参数不能提供任意命令。 */
export function buildProfile(profile, projectDir, proxy) {
    if (!['maven-java17-v1', 'gradle-java17-v1', 'sbt-java17-v1'].includes(profile)) throw new Error('BUILD_PROFILE_UNSUPPORTED');
    const project = path.posix.resolve('/work/source', projectDir);
    if (project !== '/work/source' && !project.startsWith('/work/source/')) throw new Error('BUILD_PROJECT_INVALID');
    if (proxy !== 'none' && !/^\d+\.\d+\.\d+\.\d+$/u.test(proxy)) throw new Error('BUILD_PROXY_INVALID');
    const online = proxy !== 'none';
    const toolchain = JSON.parse(fs.readFileSync('/tools/toolchain.json', 'utf8'));
    const proxyOptions = online ? `-Dhttps.proxyHost=${proxy} -Dhttps.proxyPort=3128 -Dhttp.proxyHost=${proxy} -Dhttp.proxyPort=3128` : '';
    const env = { ...process.env, PATH: '/tools/node/bin:/tools/maven/bin:/tools/gradle/bin:/opt/java/openjdk/bin:/usr/bin:/bin',
        GRADLE_USER_HOME: '/work/home/.gradle', COURSIER_CACHE: '/work/home/.cache/coursier',
        COURSIER_REPOSITORIES: 'https://repo.maven.apache.org/maven2',
        JAVA_TOOL_OPTIONS: '-Djava.io.tmpdir=/work/tmp -Duser.home=/work/home -Dfile.encoding=UTF-8 '
            + `-Djavax.net.ssl.trustStore=/trust/cacerts -Djavax.net.ssl.trustStorePassword=changeit ${proxyOptions}` };
    const run = (executable, args, capture = false) => {
        try {
            return execFileSync(executable, args, { cwd: project, env, encoding: 'utf8', maxBuffer: API_BYTES,
                stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] });
        } catch (error) {
            if (capture && error.stdout) process.stdout.write(error.stdout);
            throw error;
        }
    };
    let executable;
    let options;
    let tasks;
    if (profile === 'maven-java17-v1') {
        const settings = '<settings><mirrors><mirror><id>community-central</id><mirrorOf>*</mirrorOf>'
            + '<url>https://repo.maven.apache.org/maven2</url></mirror></mirrors>'
            + (online ? `<proxies><proxy><id>community</id><active>true</active><protocol>https</protocol><host>${proxy}</host><port>3128</port></proxy></proxies>` : '')
            + '</settings>';
        fs.writeFileSync('/work/settings.xml', settings, 'utf8');
        executable = '/tools/maven/bin/mvn';
        options = ['-B', '-ntp', '-s', '/work/settings.xml', '-Dmaven.repo.local=/work/home/.m2/repository', ...(online ? [] : ['-o'])];
        tasks = ['clean', 'verify'];
    } else if (profile === 'gradle-java17-v1') {
        executable = '/tools/gradle/bin/gradle';
        options = ['--no-daemon', '--console=plain', '--no-configuration-cache', '--no-build-cache', '--max-workers=2',
            '-Dorg.gradle.java.installations.auto-download=false', ...(online ? [] : ['--offline'])];
        tasks = ['clean', 'check', 'jar'];
    } else {
        executable = '/opt/java/openjdk/bin/java';
        options = [`-Dsbt.version=${toolchain.sbt.version}`, '-Dsbt.override.build.repos=true', '-Dsbt.repository.config=/tools/sbt-repositories',
            '-Dsbt.boot.directory=/work/home/.sbt/boot', '-Dsbt.global.base=/work/home/.sbt', '-Dsbt.ivy.home=/work/home/.ivy2',
            '-Dsbt.supershell=false', '-Dsbt.server.autostart=false', '-jar', '/tools/sbt-launch.jar'];
        tasks = [...(online ? [] : ['set offline := true']), 'clean', 'test', 'packageBin'];
    }
    run(executable, [...options, ...tasks]);
    const output = run(executable, [...options, ...modelArguments(profile, '/work/effective-pom.xml', '/tools/tools/community-model.gradle')], true);
    fs.writeFileSync('/work/model-output.txt', output, 'utf8');
}

main(import.meta.url, () => {
    if (process.argv.length !== 5) throw new Error('BUILD_PROFILE_ARGUMENTS');
    buildProfile(...process.argv.slice(2));
});
