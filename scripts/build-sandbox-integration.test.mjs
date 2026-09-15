import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPolicy, withBuildSandbox } from './build-sandbox.mjs';
import { root } from './sdk.mjs';
import { copyBuildScripts } from './build-tools.mjs';

test('Linux 实际容器复核资源、拒绝磁盘耗尽并结束超时子进程', async () => {
    const policy = { ...buildPolicy, cpus: 1, memoryBytes: 128 * 1024 * 1024, diskBytes: 64 * 1024 * 1024,
        pids: 32, timeoutMs: 10000 };
    let workspace;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-sandbox-test-'));
    await withBuildSandbox(async sandbox => {
        workspace = sandbox.workspace;
        fs.mkdirSync(path.join(sandbox.writable, 'source'));
        const stats = await sandbox.run({ phase: 'probe', tools: root,
            command: ['/bin/sh', '-c', 'test ! -e /var/run/docker.sock && test ! -w /etc/passwd && '
                + 'test ! -e /configuration/ca.key && test -r /trust/ca.pem && test ! -w /trust/ca.pem && '
                + 'test -r /trust/cacerts && test ! -w /trust/cacerts && '
                + 'test "$(id -u)" != 0 && test "$(cat /sys/fs/cgroup/memory.max)" = 134217728 && '
                + 'test "$(cat /sys/fs/cgroup/pids.max)" = 32 && echo output > /work/source/output.txt && '
                + 'mkdir /work/restricted && dd if=/dev/zero of=/work/restricted/data bs=1048576 count=1 && '
                + 'chmod 000 /work/restricted'] });
        assert.equal(fs.readFileSync(path.join(sandbox.writable, 'source/output.txt'), 'utf8'), 'output\n');
        assert.ok(stats.memoryPeakBytes > 0 && stats.memoryPeakBytes <= policy.memoryBytes);
        assert.ok(stats.pidsPeak > 0 && stats.pidsPeak <= policy.pids);
        const diskUsage = fs.statfsSync(sandbox.writable);
        assert.equal(stats.diskBytes, (diskUsage.blocks - diskUsage.bfree) * diskUsage.bsize);
        assert.ok(stats.diskBytes > 1024 * 1024 && stats.diskBytes < policy.diskBytes);
        const modelTools = path.join(directory, 'model-tools');
        for (const folder of ['node/bin', 'maven/bin']) fs.mkdirSync(path.join(modelTools, folder), { recursive: true });
        fs.copyFileSync(process.execPath, path.join(modelTools, 'node/bin/node'));
        copyBuildScripts(modelTools);
        fs.writeFileSync(path.join(modelTools, 'toolchain.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(modelTools, 'maven/bin/mvn'), '#!/bin/sh\ncase "$*" in *effective-pom*) echo MODEL_QUERY_FAILED; exit 7 ;; *) exit 0 ;; esac\n', { mode: 0o755 });
        const diskStats = await sandbox.run({ phase: 'disk-stats', tools: modelTools,
            command: ['/tools/node/bin/node', '--input-type=module', '-e',
                'import fs from "node:fs"; import assert from "node:assert/strict"; '
                + 'assert.notEqual(process.getuid(), 0); '
                + 'assert.throws(() => fs.readdirSync("/work/restricted"), { code: "EACCES" }); '
                + 'const s = fs.statfsSync("/work"); console.log((s.blocks - s.bfree) * s.bsize);'] });
        assert.equal(diskStats.diskBytes, Number(fs.readFileSync(path.join(workspace, 'disk-stats.log'), 'utf8').trim()));
        await assert.rejects(sandbox.run({ phase: 'model-failure', tools: modelTools,
            command: ['/tools/node/bin/node', '/tools/scripts/build-profile.mjs', 'maven-java17-v1', '.', 'none'] }), /BUILD_EXIT_1/u);
        assert.match(fs.readFileSync(path.join(workspace, 'model-failure.log'), 'utf8'), /MODEL_QUERY_FAILED/u);
        await assert.rejects(sandbox.run({ phase: 'disk-full', tools: root,
            command: ['/bin/dd', 'if=/dev/zero', 'of=/work/full.bin', 'bs=1048576', 'count=128'] }), /BUILD_EXIT_/u);
        const full = JSON.parse(fs.readFileSync(path.join(workspace, 'disk-full.json'), 'utf8'));
        assert.ok(full.diskBytes > policy.diskBytes / 2 && full.diskBytes < policy.diskBytes);
        await assert.rejects(sandbox.run({ phase: 'timeout', tools: root,
            command: ['/bin/sh', '-c', 'sleep 120 & wait'] }), /BUILD_TIMEOUT/u);
    }, { policy, directory });
    assert.equal(fs.existsSync(path.join(workspace, 'disk.img')), false);
    assert.equal(fs.existsSync(path.join(workspace, 'proxy/ca.key')), false);
});
