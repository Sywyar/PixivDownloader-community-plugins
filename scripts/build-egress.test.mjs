import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildPolicy, containerOptions } from './build-sandbox.mjs';
import { prepareProxy } from './build-proxy.mjs';
import { root } from './sdk.mjs';

// 独立的 Docker 验收入口，实际执行代理及网络拒绝，不用配置文本检查替代。
test('预取核对 CONNECT、TLS 与请求主机；拒绝域名伪装、直连与离线代理访问', async () => {
    const network = 'community-' + crypto.randomBytes(12).toString('hex');
    const proxy = network + '-proxy';
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'target/egress-'));
    fs.chmodSync(directory, 0o755);
    const configuration = path.join(directory, 'proxy');
    const trust = await prepareProxy(configuration, { ...buildPolicy,
        artifactHosts: [...buildPolicy.artifactHosts, 'self-signed.badssl.com'] });
    const uid = process.getuid() || 1000, gid = process.getgid() || 1000;
    const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    const curl = (online, ...args) => spawnSync('docker', ['run', '--rm', ...containerOptions(buildPolicy, online ? network : 'none'),
        '--mount', `type=bind,src=${trust},dst=/trust,readonly`,
        '--entrypoint=/usr/bin/curl', buildPolicy.image, '--connect-timeout', '3', '--max-time', '12', '-sS',
        '--cacert', '/trust/ca.pem',
        '-o', '/dev/null', '-w', '%{http_code}', ...args], { encoding: 'utf8', timeout: 20_000 });
    let created = false;
    let started = false;
    try {
        docker('network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network);
        created = true;
        docker('create', '--name', proxy, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            `--user=${uid}:${gid}`, '--memory=268435456', '--memory-swap=268435456', '--pids-limit=64',
            '--network=bridge', '--tmpfs=/tmp:rw,nosuid,nodev,size=16777216',
            '--mount', `type=bind,src=${configuration},dst=/configuration,readonly`, '--entrypoint=/configuration/usr/sbin/squid',
            buildPolicy.proxyImage, '-N', '-f', '/configuration/squid.conf');
        started = true;
        docker('network', 'connect', network, proxy);
        docker('start', proxy);
        const address = JSON.parse(docker('inspect', proxy))[0].NetworkSettings.Networks[network].IPAddress;
        const proxyUrl = `http://${address}:3128`;
        const allowed = curl(true, '--proxy', proxyUrl, 'https://repo.maven.apache.org/maven2/org/apache/maven/maven/maven-metadata.xml');
        assert.equal(allowed.status, 0, allowed.stderr + docker('logs', proxy));
        assert.equal(allowed.stdout, '200');
        const fronted = curl(true, '--proxy', proxyUrl, '--connect-to',
            'www.cloudflare.com:443:repo.maven.apache.org:443', 'https://www.cloudflare.com/cdn-cgi/trace');
        assert.notEqual(fronted.status, 0, 'Unapproved TLS SNI must not traverse an approved CONNECT target');
        for (const args of [['-H', 'Host: www.cloudflare.com'], ['--request-target', 'https://www.cloudflare.com/'],
            ['-H', 'Upgrade: websocket', '-H', 'Connection: Upgrade'], ['-X', 'POST']]) {
            const blocked = curl(true, '--proxy', proxyUrl, '--dump-header', '-', ...args,
                'https://repo.maven.apache.org/maven2/org/apache/maven/maven/maven-metadata.xml');
            assert.ok(blocked.status !== 0 || /X-Squid-Error: (?:ERR_ACCESS_DENIED|ERR_SECURE_CONNECT_FAIL|ERR_CONFLICT_HOST)/iu.test(blocked.stdout),
                JSON.stringify(args) + ': ' + blocked.stdout);
        }
        const invalidCertificate = curl(true, '--proxy', proxyUrl, '--dump-header', '-', 'https://self-signed.badssl.com/');
        assert.ok(invalidCertificate.status !== 0 || /X-Squid-Error: ERR_SECURE_CONNECT_FAIL/iu.test(invalidCertificate.stdout),
            invalidCertificate.stdout);
        assert.notEqual(curl(true, '--proxy', proxyUrl, '--cacert', '/etc/ssl/certs/ca-certificates.crt',
            'https://repo.maven.apache.org/maven2/').status, 0);
        for (const url of ['https://example.com/', 'https://127.0.0.1/', 'http://repo.maven.apache.org/maven2/']) {
            const blocked = curl(true, '--proxy', proxyUrl, url);
            assert.ok(blocked.status !== 0 || blocked.stdout === '403', url + ': ' + blocked.stdout);
        }
        assert.notEqual(curl(true, 'https://repo.maven.apache.org/maven2/').status, 0);
        assert.notEqual(curl(false, '--proxy', proxyUrl, 'https://repo.maven.apache.org/maven2/').status, 0);
        const settings = JSON.parse(docker('network', 'inspect', network))[0];
        assert.equal(settings.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
        assert.equal(settings.Internal, true);
        assert.equal(settings.EnableIPv6, false);
        for (const entry of settings.IPAM.Config) {
            if (entry.Gateway) assert.notEqual(curl(true, `http://${entry.Gateway}:80/`).status, 0);
        }
    } finally {
        if (started) docker('rm', '-f', proxy);
        if (created) docker('network', 'rm', network);
        fs.unlinkSync(path.join(configuration, 'ca.key'));
    }
});
