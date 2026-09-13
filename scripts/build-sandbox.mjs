import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { API_BYTES, API_TIMEOUT } from './github.mjs';
import { root } from './sdk.mjs';
import { prepareProxy } from './build-proxy.mjs';

export const buildPolicy = Object.freeze(JSON.parse(fs.readFileSync(new URL('./build-policy.json', import.meta.url), 'utf8')));
const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: API_TIMEOUT,
    maxBuffer: API_BYTES, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const docker = (...args) => execute('docker', args);
const privileged = (...args) => process.getuid() === 0 ? execute(args[0], args.slice(1)) : execute('sudo', ['-n', ...args]);

export function containerOptions(policy, network, uid = 1000, gid = 1000) {
    if (!/^[a-z0-9/-]+@sha256:[a-f0-9]{64}$/u.test(policy.image)
        || !/^[a-z0-9/-]+@sha256:[a-f0-9]{64}$/u.test(policy.proxyImage)
        || network !== 'none' && !/^community-[a-f0-9]{24}$/u.test(network)
        || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1
        || ['cpus', 'memoryBytes', 'diskBytes', 'pids', 'timeoutMs'].some(key => !Number.isSafeInteger(policy[key]) || policy[key] <= 0)) {
        throw new Error('BUILD_POLICY_INVALID');
    }
    return ['--platform=linux/amd64', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        `--user=${uid}:${gid}`, `--cpus=${policy.cpus}`, `--memory=${policy.memoryBytes}`,
        `--memory-swap=${policy.memoryBytes}`, `--pids-limit=${policy.pids}`, `--network=${network}`,
        '--dns=127.0.0.1', '--log-driver=none', '--init'];
}

// 挂载目录来自受保护执行器，投稿字符串不能增加 Docker 选项或宿主挂载。
function mount(source, target, readonly = true) {
    const resolved = fs.realpathSync(source);
    if (resolved.includes(',') || !fs.lstatSync(source).isDirectory()) throw new Error('BUILD_MOUNT_INVALID');
    return ['--mount', `type=bind,src=${resolved},dst=${target}${readonly ? ',readonly' : ''}`];
}

async function buildProcess(container, command, log, timeoutMs) {
    const output = fs.openSync(log, 'wx', 0o600);
    let bytes = 0;
    let failure;
    try {
        await new Promise((resolve, reject) => {
            const child = spawn('docker', ['exec', '--workdir=/work/source', container, ...command],
                { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const stop = error => {
                if (failure) return;
                failure = error;
                // 终止容器会结束它的全部子进程；只杀 Docker CLI 会留下构建继续运行。
                child.stdout.removeListener('data', consume);
                child.stderr.removeListener('data', consume);
                try { docker('kill', container); }
                catch (cleanup) { failure = new AggregateError([error, cleanup], 'BUILD_TERMINATION_FAILED'); }
                child.kill('SIGKILL');
                clearTimeout(timer);
                reject(failure);
            };
            const timer = setTimeout(() => stop(new Error('BUILD_TIMEOUT')), timeoutMs);
            const consume = chunk => {
                bytes += chunk.length;
                if (bytes > API_BYTES) return stop(new Error('BUILD_LOG_LIMIT'));
                try { fs.writeFileSync(output, chunk); } catch (error) { stop(error); }
            };
            child.stdout.on('data', consume);
            child.stderr.on('data', consume);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => {
                clearTimeout(timer);
                if (failure || code !== 0) reject(failure ?? new Error(`BUILD_EXIT_${code}`));
                else resolve();
            });
        });
    } finally { fs.closeSync(output); }
    return bytes;
}

/** 仅 Linux 一次性 runner 使用；磁盘、网络及容器都按本次随机身份创建和清理。 */
export async function withBuildSandbox(action, { directory = root, policy = buildPolicy } = {}) {
    if (process.platform !== 'linux') throw new Error('LINUX_BUILD_RUNNER_REQUIRED');
    const uid = process.getuid() || 1000;
    const gid = process.getgid() || 1000;
    const target = path.join(fs.realpathSync(directory), 'target');
    fs.mkdirSync(target, { recursive: true });
    if (fs.realpathSync(target) !== target) throw new Error('BUILD_WORKSPACE_INVALID');
    const workspace = fs.mkdtempSync(path.join(target, 'build-'));
    const network = 'community-' + crypto.randomBytes(12).toString('hex');
    const proxy = network + '-proxy';
    const disk = path.join(workspace, 'disk.img');
    const writable = path.join(workspace, 'work');
    const configuration = path.join(workspace, 'proxy');
    let mounted = false;
    let networkCreated = false;
    let proxyCreated = false;
    let completed = false;
    const containers = [];
    containerOptions(policy, network);
    fs.mkdirSync(writable);
    let trust;
    try {
        trust = await prepareProxy(configuration, policy);
        // 12 GiB 是实际文件系统容量预算；源码、缓存、临时文件与输出共用这一上限。
        execute('fallocate', ['-l', String(policy.diskBytes), disk]);
        execute('mkfs.ext4', ['-q', '-m', '0', disk]);
        privileged('mount', '-o', 'loop,nodev,nosuid', disk, writable);
        mounted = true;
        privileged('chown', `${uid}:${gid}`, writable);
        fs.mkdirSync(path.join(writable, 'home'));
        fs.mkdirSync(path.join(writable, 'tmp'));
        docker('network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network);
        networkCreated = true;
        const actual = JSON.parse(docker('network', 'inspect', network))[0];
        if (!actual.Internal || actual.EnableIPv6 || actual.Options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') {
            throw new Error('BUILD_NETWORK_NOT_ISOLATED');
        }
        // 代理是唯一双网络容器；它没有源码、构建缓存或 GitHub / 社区发布凭据挂载。
        docker('create', '--name', proxy, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            `--user=${uid}:${gid}`, '--memory=268435456', '--memory-swap=268435456', '--pids-limit=64', '--log-driver=none',
            '--network=bridge', '--tmpfs=/tmp:rw,nosuid,nodev,size=16777216', ...mount(configuration, '/configuration'),
            '--entrypoint=/configuration/usr/sbin/squid', policy.proxyImage, '-N', '-f', '/configuration/squid.conf');
        proxyCreated = true;
        docker('network', 'connect', network, proxy);
        docker('start', proxy);
        const proxyAddress = JSON.parse(docker('inspect', proxy))[0].NetworkSettings.Networks[network].IPAddress;
        if (!/^\d+\.\d+\.\d+\.\d+$/u.test(proxyAddress)) throw new Error('BUILD_PROXY_ADDRESS_INVALID');
        const run = async ({ phase, command, tools, online = false }) => {
            if (!/^[a-z][a-z0-9-]*$/u.test(phase) || !Array.isArray(command) || !command.length
                || command.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('BUILD_COMMAND_INVALID');
            const name = network + '-' + phase;
            if (containers.includes(name)) throw new Error('BUILD_PHASE_REUSED');
            const started = performance.now();
            if (process.getuid() === 0) privileged('chown', '-hR', `${uid}:${gid}`, writable);
            const args = ['create', '--name', name, ...containerOptions(policy, online ? network : 'none', uid, gid),
                ...mount(writable, '/work', false), ...mount(tools, '/tools'),
                ...mount(trust, '/trust'),
                ...mount(path.join(writable, 'tmp'), '/tmp', false),
                '--env=HOME=/work/home', '--env=TMPDIR=/work/tmp', '--env=LANG=C.UTF-8', '--env=TZ=UTC',
                '--env=SSL_CERT_FILE=/trust/ca.pem',
                '--env=JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/work/tmp -Duser.home=/work/home',
                '--entrypoint=/bin/sleep', policy.image, 'infinity'];
            docker(...args);
            containers.push(name);
            docker('start', name);
            const jdkVersion = /^JAVA_RUNTIME_VERSION="([^"]+)"$/mu.exec(docker('exec', name, '/bin/cat', '/opt/java/openjdk/release'))?.[1];
            if (!jdkVersion) throw new Error('BUILD_JDK_IDENTITY_MISSING');
            let failure;
            let logBytes;
            const log = path.join(workspace, `${phase}.log`);
            try { logBytes = await buildProcess(name, command, log, policy.timeoutMs); }
            catch (error) { failure = error; }
            let measurement;
            try {
                const diskUsage = fs.statfsSync(writable);
                measurement = { elapsedMs: Math.ceil(performance.now() - started), logBytes, jdkVersion,
                    memoryPeakBytes: Number(docker('exec', name, '/bin/cat', '/sys/fs/cgroup/memory.peak')),
                    pidsPeak: Number(docker('exec', name, '/bin/cat', '/sys/fs/cgroup/pids.peak')),
                    diskBytes: (diskUsage.blocks - diskUsage.bfree) * diskUsage.bsize };
            } catch (error) { failure ??= error; }
            docker('rm', '-f', name);
            containers.splice(containers.indexOf(name), 1);
            fs.writeFileSync(path.join(workspace, `${phase}.json`), JSON.stringify({ ...measurement,
                error: failure?.message ?? null }), 'utf8');
            if (failure) throw failure;
            return measurement;
        };
        const result = await action({ workspace, writable, proxyAddress, run });
        completed = true;
        return result;
    } finally {
        // 清理失败必须可见；保留日志与原始磁盘文件供本次诊断，不扫描其它运行的资源。
        const failures = [];
        for (const name of [...containers, ...(proxyCreated ? [proxy] : [])]) {
            try { docker('rm', '-f', name); } catch (error) { failures.push(error); }
        }
        if (networkCreated) try { docker('network', 'rm', network); } catch (error) { failures.push(error); }
        if (mounted) try { privileged('umount', writable); } catch (error) { failures.push(error); }
        const key = path.join(configuration, 'ca.key');
        if (fs.existsSync(key)) try { fs.unlinkSync(key); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'BUILD_SANDBOX_CLEANUP_FAILED');
        if (completed) fs.unlinkSync(disk);
    }
}
