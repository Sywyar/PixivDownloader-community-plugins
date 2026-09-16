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
        assert.deepEqual(archivedCandidates(checked, endpoint => endpoint === prefix
            ? { permissions: { push: job.permissions.contents === 'write' } } : [[release]]), [release]);
    }
    const build = read('submission-check');
    for (const job of Object.values(build.jobs)) assert.equal((job.permissions ?? build.permissions).contents, 'read');
    assert.equal(read('community-archive').concurrency.group, read('community-review-complete').concurrency.group);
    assert.equal(read('community-archive').concurrency.group, read('community-publication').concurrency.group);
    assert.equal(read('community-gate').jobs.notify.permissions.contents, 'read');
});

test('缺少草稿读取权限不能伪装成归档等待，可选构建复用不提升权限', () => {
    const checked = { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' }, pr: { number: 7 } };
    for (const permissions of [{ push: false }, undefined]) {
        const call = endpoint => { assert.equal(endpoint, prefix); return { permissions }; };
        assert.throws(() => archivedCandidates(checked, call), /CANDIDATE_ARCHIVE_READ_FORBIDDEN/);
        assert.deepEqual(archivedCandidates(checked, call, { optional: true }), []);
    }
    const call = endpoint => endpoint === prefix ? { permissions: { push: true } } : [[]];
    assert.deepEqual(archivedCandidates(checked, call), []);
});
