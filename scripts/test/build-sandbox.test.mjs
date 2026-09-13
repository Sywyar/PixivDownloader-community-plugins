import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPolicy, containerOptions, proxyConfiguration } from '../build-sandbox.mjs';

test('构建参数限制网络、权限和资源，离线容器不继承预取网络', () => {
    const policy = { ...buildPolicy, cpus: 3, memoryBytes: 4096, diskBytes: 8192, pids: 23, timeoutMs: 5000 };
    const offline = containerOptions(policy, 'none', 1234, 2345);
    for (const argument of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--memory=4096', '--memory-swap=4096', '--cpus=3', '--pids-limit=23', '--user=1234:2345', '--dns=127.0.0.1']) {
        assert.ok(offline.includes(argument), argument);
    }
    assert.ok(containerOptions(policy, 'community-' + 'a'.repeat(24)).includes('--network=community-' + 'a'.repeat(24)));
    assert.throws(() => containerOptions(policy, 'host'), /BUILD_POLICY_INVALID/u);
    assert.throws(() => containerOptions({ ...policy, image: 'jdk:latest' }, 'none'), /BUILD_POLICY_INVALID/u);
    assert.throws(() => containerOptions({ ...policy, memoryBytes: 0 }, 'none'), /BUILD_POLICY_INVALID/u);
    assert.throws(() => containerOptions(policy, 'none', 0, 0), /BUILD_POLICY_INVALID/u);
});

test('制品代理只接受完整主机名，拒绝配置注入与通配域名', () => {
    for (const hosts of [[], ['*.example.com'], ['.example.com'], ['a.example\nhttp_access allow all'], ['a.example', 'a.example']]) {
        assert.throws(() => proxyConfiguration(hosts), /ARTIFACT_HOSTS_INVALID/u);
    }
    const config = proxyConfiguration(['repo.example.com']);
    assert.ok(config.includes('acl approved dstdomain repo.example.com\n'));
    assert.ok(config.includes('http_access deny !CONNECT\n'));
    assert.ok(config.includes('http_access deny !TLS\n'));
    assert.ok(config.indexOf('http_access deny private') < config.indexOf('http_access allow approved'));
});
