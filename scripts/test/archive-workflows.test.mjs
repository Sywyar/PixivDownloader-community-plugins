import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { prepareSdk, root } from '../sdk.mjs';
import { archivedCandidates } from '../archive-read.mjs';
import { candidateSlot } from '../candidate.mjs';
import { prefix } from '../github.mjs';

test('真实 YAML 按社区操作核对全部作业权限、令牌来源和受保护执行边界', () => {
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
    // 实际条件和输出选择共同决定是否通知；空数组不能因为字符串非空而启动作业。
    for (const [name, stages] of [['community-gate', ['gate']], ['community-status', ['store']],
        ['community-review-complete', ['preflight', 'store']], ['community-publication', ['finalize']]]) {
        const workflow = read(name), final = name === 'community-publication';
        const job = workflow.jobs[final ? 'finalize' : 'notify'];
        const step = job.steps.find(step => step.env?.COMMUNITY_PROJECTIONS);
        const condition = final ? step.if : job.if;
        const scope = final ? 'steps' : 'needs';
        const evaluate = values => runInNewContext(condition, { always: () => true,
            [scope]: Object.fromEntries(stages.map((stage, i) => [stage, { outputs: { projections: values[i] } }])) });
        for (const empty of ['', '[]', undefined]) assert.equal(evaluate(stages.map(() => empty)), false);
        const pending = JSON.stringify([{ number: 7, head: 'a'.repeat(40) }]);
        for (let i = 0; i < stages.length; i++) assert.equal(evaluate(stages.map((_, j) => i === j ? pending : '')), true);
        if (stages.length > 1) assert.equal(evaluate(stages.map((_, i) => i === stages.length - 1 ? '[]' : pending)), false);
    }
    // 合同按实际 API 操作定义；遍历所有入口，新增带令牌的命令必须登记其职责。
    const inspect = { contents: 'write', actions: 'read', 'pull-requests': 'read' };
    const notify = { contents: 'read', actions: 'read', 'pull-requests': 'write' };
    const commands = {
        'community-emergency.mjs': { contents: 'write', actions: 'write', 'pull-requests': 'write' },
        'community-emergency.mjs notify': notify,
        'community-gate.mjs prepare': inspect,
        'community-gate.mjs publish': inspect,
        'community-gate.mjs notify': notify,
        'decisions.mjs': inspect,
        'community-publication.mjs preflight': inspect,
        'community-publication.mjs prepare': inspect,
        'community-publication.mjs store': inspect,
        'community-publication.mjs merge': { contents: 'write', actions: 'write', 'pull-requests': 'read' },
        'community-publication.mjs finalize': inspect,
        'community-publication.mjs finalize-notify': notify,
        'community-publication.mjs notify': notify,
        'community-status.mjs preflight': inspect,
        'community-status.mjs prepare': inspect,
        'community-status.mjs store': inspect,
        'community-status.mjs merge': { contents: 'write', actions: 'write', 'pull-requests': 'read' },
        'community-status.mjs notify': notify,
        'community-renewal.mjs': { contents: 'write', actions: 'write', 'pull-requests': 'write' },
        'archive-run.mjs': inspect,
        'archive-run.mjs preflight': { contents: 'read', actions: 'read' },
        'archive-run.mjs attestation': inspect,
        'candidate-cleanup.mjs': inspect,
        'candidate-run.mjs': { contents: 'read', 'pull-requests': 'read' },
        'submission-build.mjs': { contents: 'read', actions: 'read', 'pull-requests': 'read' },
        'submission-build.mjs previous': inspect,
    };
    const levels = { none: 0, read: 1, write: 2 }, exercised = new Set();
    for (const file of fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/u.test(file))) {
        const workflow = read(file.replace(/\.ya?ml$/u, ''));
        assert(Object.values(workflow.permissions).every(value => value === 'read'), `${file}: default token must remain read-only`);
        const protectedJob = name => {
            const job = workflow.jobs[name], dependencies = [].concat(job.needs ?? []);
            return job.if?.includes('refs/heads/master') || dependencies.length > 0 && dependencies.every(protectedJob);
        };
        for (const [jobName, job] of Object.entries(workflow.jobs)) {
            const permissions = job.permissions ?? workflow.permissions;
            const require = (required, operation) => {
                for (const [permission, level] of Object.entries(required)) {
                    assert((levels[permissions[permission] ?? 'none'] ?? -1) >= levels[level], `${file}/${jobName}: ${operation} requires ${permission}:${level}`);
                }
            };
            const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
            if (checkout) {
                require({ contents: 'read' }, 'checkout');
                assert.equal(checkout.with['persist-credentials'], false);
            }
            if (Object.values(permissions).includes('write')) {
                assert(protectedJob(jobName), `${file}/${jobName}: protected branch required`);
                assert.equal(checkout.with.ref, '${{ github.workflow_sha }}');
            }
            for (const step of job.steps) {
                if (step.env?.GH_TOKEN) {
                    assert.equal(step.env.GH_TOKEN, '${{ github.token }}');
                    const command = /^node scripts\/(.+)$/u.exec(step.run)?.[1];
                    assert(commands[command], `${file}/${jobName}: unaudited token operation ${step.run}`);
                    require(commands[command], command); exercised.add(command);
                }
                if (step.uses?.startsWith('actions/attest@')) require({ 'id-token': 'write', attestations: 'write' }, 'attestation');
                if (step.uses?.startsWith('actions/create-github-app-token@')) {
                    assert.equal(step.with['permission-checks'], 'write');
                    assert.equal(step.with.repositories, 'PixivDownloader-community-plugins');
                    assert.equal(job.steps.find(row => row.env?.GATE_TOKEN)?.env.GATE_TOKEN, '${{ steps.app.outputs.token }}');
                }
                if (step.env?.COMMUNITY_REVIEW_BRANCH_TOKEN) {
                    assert(['release', 'community-status'].includes(job.environment));
                    assert.equal(step.env.COMMUNITY_REVIEW_BRANCH_TOKEN, '${{ secrets.COMMUNITY_REVIEW_BRANCH_TOKEN }}');
                }
            }
        }
    }
    assert.deepEqual(exercised, new Set(Object.keys(commands)));
    const publication = read('community-publication').jobs.finalize.steps;
    const finish = publication.find(step => step.run === 'node scripts/community-publication.mjs finalize');
    const notification = publication.find(step => step.run === 'node scripts/community-publication.mjs finalize-notify');
    assert(publication.indexOf(notification) > publication.indexOf(finish));
    assert.equal(notification.env.COMMUNITY_PROJECTIONS, '${{ steps.' + finish.id + '.outputs.projections }}');
    assert.equal(notification['continue-on-error'], undefined);
    const checked = { owner: { accountId: '101', accountType: 'User', publisherId: 'example' },
        submission: { pluginId: 'demo', version: '2.3.4' }, pr: { number: 7 } };
    const release = { id: 1, draft: true, tag_name: candidateSlot(checked) };
    for (const [file, jobName] of [['community-gate', 'prepare'], ['community-review-decision', 'decision'], ['community-review-complete', 'preflight']]) {
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
    assert.equal((build.jobs.submission.permissions ?? build.permissions).contents, 'read');
    assert.equal(build.jobs.submission.needs, 'previous');
    const previous = build.jobs.previous;
    assert.deepEqual(previous.permissions, { contents: 'write', actions: 'read', 'pull-requests': 'read' });
    assert.deepEqual(previous.steps.filter(step => step.run).map(step => step.run), ['node scripts/submission-build.mjs previous']);
    const previousCheckout = previous.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(previousCheckout.with.ref, '${{ github.workflow_sha }}');
    assert.equal(previousCheckout.with['persist-credentials'], false);
    assert.equal(previous.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).with['retention-days'], 1);
    const previousDownload = build.jobs.submission.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(previousDownload.with['artifact-ids'], '${{ needs.previous.outputs.artifact }}');
    assert.equal(previousDownload.with['run-id'], undefined);
    assert.equal(previousDownload.with.repository, undefined);
    const archive = read('community-archive');
    assert.equal(archive.concurrency, undefined);
    assert.equal(archive.jobs.preflight.concurrency, undefined);
    assert.deepEqual(archive.jobs.preflight.permissions, { contents: 'read', actions: 'read' });
    for (const candidate of ['false', '', undefined, 'true']) assert.equal(
        runInNewContext(archive.jobs.archive.if, { needs: { preflight: { outputs: { candidate } } } }), candidate === 'true');
    assert.equal(archive.jobs.archive.concurrency.group, read('community-review-complete').jobs.store.concurrency.group);
    assert.equal(archive.jobs.archive.concurrency.group, read('community-publication').concurrency.group);
    const cleanup = read('community-candidate-cleanup');
    const emergency = read('community-emergency');
    const reviewEvent = read('community-review-event'), automatic = read('community-status');
    assert(automatic.on.workflow_run.workflows.includes(reviewEvent.name));
    assert.deepEqual(automatic.on.workflow_run.types, ['completed']);
    assert.deepEqual(reviewEvent.permissions, {});
    assert.deepEqual(reviewEvent.on.pull_request_review.types, ['submitted', 'edited', 'dismissed']);
    assert.deepEqual(emergency.on.pull_request_target.branches, ['emergency-state']);
    assert.equal(emergency.jobs.apply.environment, 'community-status');
    assert.equal(emergency.concurrency.group, read('community-gate').jobs.gate.concurrency.group);
    assert.equal(emergency.concurrency.group, read('community-status').jobs.store.concurrency.group);
    const finalGate = read('community-gate').jobs.gate;
    assert(finalGate.if.includes('always()'));
    assert(finalGate.if.includes('!cancelled()'));
    const shouldGate = (result, requests) => runInNewContext(finalGate.if, { always: () => true, cancelled: () => false,
        github: { repository: 'Sywyar/PixivDownloader-community-plugins', ref: 'refs/heads/master' },
        needs: { prepare: { result, outputs: { requests } } } });
    assert.equal(shouldGate('success', 'false'), false);
    for (const result of ['failure', 'skipped']) assert.equal(shouldGate(result, 'false'), true);
    assert.equal(shouldGate('success', undefined), true);
    assert(!read('community-gate').on.pull_request_target.types.includes('labeled'));
    assert(!read('community-gate').on.pull_request_target.types.includes('unlabeled'));
    assert.equal(finalGate.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))['continue-on-error'], true);
    assert.equal(finalGate.steps.find(step => step.id === 'gate')['continue-on-error'], undefined);
    // 人工批准在队列外，最新主线准备、签名、检查和合并持有同一把锁。
    for (const name of ['community-review-complete', 'community-status']) {
        const workflow = read(name);
        assert.equal(workflow.concurrency, undefined);
        const final = workflow.jobs.store;
        assert.equal(final.environment, 'community-status');
        assert.deepEqual(final.concurrency, { group: 'community-publication', queue: 'max' });
        const ids = final.steps.map(step => step.id).filter(Boolean);
        for (const [first, second] of [['prepare', 'proof'], ['proof', 'store'], ['store', 'app'], ['app', 'merge']]) {
            assert(ids.indexOf(first) < ids.indexOf(second));
        }
        assert(!final.steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
        if (name === 'community-review-complete') {
            assert.equal(workflow.jobs.apply.environment, 'release');
            assert.equal(workflow.jobs.apply.concurrency, undefined);
            assert.deepEqual(workflow.jobs.apply.permissions, {});
            assert.equal(final.needs, 'apply');
        }
    }
    const gate = read('community-gate');
    assert.equal(gate.jobs.prepare.concurrency, undefined);
    assert.equal(gate.jobs.gate.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with['artifact-ids'], '${{ needs.prepare.outputs.artifact }}');
    assert.equal(emergency.concurrency.group, read('community-publication').concurrency.group);
    assert.equal(cleanup.concurrency.group, archive.jobs.archive.concurrency.group);
    assert.equal(cleanup.concurrency.queue, 'max');
    assert.deepEqual(cleanup.on.pull_request_target, { branches: ['master'], types: ['closed'] });
    assert.equal(cleanup.on.schedule.length, 1);
    assert(Object.hasOwn(cleanup.on, 'workflow_dispatch'));
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
