import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareSdk, root } from '../sdk.mjs';
import { archivedCandidates } from '../archive-read.mjs';
import { candidateSlot } from '../candidate.mjs';
import { prefix } from '../github.mjs';

test('真实 YAML 的归档读权限只授予受保护审核作业，投稿构建保持只读', () => {
    // 使用固定 SDK 已包含的 YAML 解析器，断言实际配置而非匹配源码文本。
    const sdk = prepareSdk(), source = path.join(sdk.workspace, 'WorkflowJson.java');
    fs.writeFileSync(source, `import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
public class WorkflowJson {
    public static void main(String[] args) throws Exception {
        System.out.print(new ObjectMapper().writeValueAsString(new YAMLMapper().readValue(new File(args[0]), Object.class)));
    }
}`, 'utf8');
    sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', sdk.classpath, '-d', path.join(sdk.workspace, 'runtime'), source]);
    const read = file => JSON.parse(sdk.run('java', ['-cp', sdk.classpath, 'WorkflowJson', path.join(root, '.github/workflows', file + '.yml')]));
    const checked = { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' }, pr: { number: 7 } };
    const release = { id: 1, draft: true, tag_name: candidateSlot(checked) };
    for (const [file, jobName] of [['community-gate', 'gate'], ['community-review-decision', 'decision'], ['community-review-complete', 'preflight']]) {
        const workflow = read(file), job = workflow.jobs[jobName];
        assert.equal(workflow.permissions.contents, 'read');
        assert.equal(job.permissions.contents, 'write');
        assert(job.if.includes('refs/heads/master'));
        const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
        assert.equal(checkout.with.ref, '${{ github.workflow_sha }}');
        assert.equal(checkout.with['persist-credentials'], false);
        const script = job.steps.find(step => step.id === jobName);
        assert.equal(script.env.GH_TOKEN, '${{ github.token }}');
        assert.deepEqual(archivedCandidates(checked, endpoint => {
            assert.equal(endpoint, `${prefix}/releases?per_page=100`);
            return [[release]];
        }), [release]);
    }
    const build = read('submission-check');
    for (const job of Object.values(build.jobs)) assert.equal((job.permissions ?? build.permissions).contents, 'read');
    assert.equal(read('community-archive').concurrency.group, read('community-review-complete').concurrency.group);
    assert.equal(read('community-archive').concurrency.group, read('community-publication').concurrency.group);
    const cleanup = read('community-candidate-cleanup');
    assert.equal(cleanup.concurrency.group, read('community-archive').concurrency.group);
    assert.equal(cleanup.concurrency.queue, 'max');
    assert.deepEqual(cleanup.on.pull_request_target, { branches: ['master'], types: ['closed'] });
    assert.equal(cleanup.permissions.contents, 'read');
    assert.deepEqual(cleanup.jobs.cleanup.permissions, { contents: 'write', actions: 'read', 'pull-requests': 'read' });
    assert(cleanup.jobs.cleanup.if.includes('github.event.pull_request.merged == false'));
    assert(cleanup.jobs.cleanup.if.includes('refs/heads/master'));
    const checkout = cleanup.jobs.cleanup.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.workflow_sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(cleanup.jobs.cleanup.steps.find(step => step.run)?.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(read('community-gate').jobs.notify.permissions.contents, 'read');
});

test('候选发现使用实际可见草稿，不要求 installation token 返回仓库 push 角色', () => {
    const checked = { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' }, pr: { number: 7 } };
    const release = { id: 1, draft: true, tag_name: candidateSlot(checked) };
    for (const permissions of [undefined, { push: false }]) {
        const call = endpoint => {
            if (endpoint === prefix) return { permissions };
            assert.equal(endpoint, `${prefix}/releases?per_page=100`);
            return [[release, { ...release, id: 2, draft: false }]];
        };
        assert.deepEqual(archivedCandidates(checked, call), [release]);
        assert.deepEqual(archivedCandidates(checked, call, { optional: true }), [release]);
    }
    assert.deepEqual(archivedCandidates(checked, () => [[]]), []);
});

test('Release API 认证拒绝阻断审核，可选复用仅忽略明确的认证拒绝', () => {
    const checked = { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' }, pr: { number: 7 } };
    for (const status of [401, 403]) {
        for (const failure of [Object.assign(new Error('denied'), { status }),
            Object.assign(new Error('gh failed'), { status: 1, stderr: Buffer.from(`gh: denied (HTTP ${status})`) })]) {
            const call = () => { throw failure; };
            assert.throws(() => archivedCandidates(checked, call),
                error => error.message === 'CANDIDATE_ARCHIVE_READ_FORBIDDEN' && error.cause === failure);
            assert.deepEqual(archivedCandidates(checked, call, { optional: true }), []);
        }
    }
    for (const failure of [Object.assign(new Error('not found'), { status: 404 }),
        Object.assign(new Error('server error'), { status: 500 }), new Error('network timeout')]) {
        for (const optional of [false, true]) {
            assert.throws(() => archivedCandidates(checked, () => { throw failure; }, { optional }), error => error === failure);
        }
    }
});
