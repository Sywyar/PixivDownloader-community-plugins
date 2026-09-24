import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executionFailure, executionProjection, waitingProjection } from '../community-publication.mjs';
import { notify } from '../community-gate.mjs';
import { policy, prefix } from '../github.mjs';

const head = 'a'.repeat(40);
const pr = { number: 7, state: 'open', merged: false, user: { id: '101', type: 'User' }, head: { sha: head, repo: { id: '201' } }, base: { ref: 'master', repo: { id: policy.repositoryId } } };
const context = { run: { id: '91', run_attempt: 2 } };

test('Gate 摘要不覆盖执行失败，恢复更新同一执行评论并拒绝旧 head', () => {
    const comments = [], labels = [], bot = { id: 41898282, type: 'Bot' };
    let current = structuredClone(pr), writes = 0;
    const call = (endpoint, options = {}) => {
        if (endpoint === prefix + '/pulls/7') return current;
        if (endpoint === prefix + '/issues/7/comments?per_page=100') return [structuredClone(comments)];
        if (endpoint === prefix + '/issues/7/labels?per_page=100') return [labels.map((name, i) => ({ id: i + 1, name }))];
        if (endpoint === prefix + '/issues/7/labels') { labels.push(...options.body.labels); return; }
        writes++;
        if (endpoint === prefix + '/issues/7/comments') comments.push({ id: comments.length + 1, user: bot, body: options.body.body });
        else comments.find(comment => endpoint === prefix + '/issues/comments/' + comment.id).body = options.body.body;
    };
    const failure = waitingProjection(pr, 'REVIEW_BRANCH_WRITE_FAILED', context, { transport: 'ssh', phase: 'push', reason: 'GIT_AUTH_REQUIRED', exitCode: 128 });
    notify([failure], call);
    const original = comments[0].body;
    assert(original.includes('GIT_AUTH_REQUIRED'));
    assert(original.includes('/actions/runs/91/attempts/2'));
    notify([{ number: 7, head, labels: ['review:pending'], summary: 'Waiting for protected preparation.' }], call);
    assert.equal(comments.length, 2); assert.equal(comments[0].body, original);
    notify([executionProjection(pr, { run: { id: '92', run_attempt: 1 } }, 'Prepared successfully')], call);
    assert.equal(comments.length, 2); assert(!comments[0].body.includes('GIT_AUTH_REQUIRED'));
    assert(comments[1].body.includes('Waiting for protected preparation.'));
    const before = writes; current = { ...current, head: { ...current.head, sha: 'b'.repeat(40) } };
    notify([failure], call); assert.equal(writes, before);
    const unknown = executionFailure(pr, context, new Error('command includes sensitive output'));
    assert(unknown.summary.startsWith('REQUEST_EXECUTION_FAILED\n'));
    assert(!unknown.summary.includes('sensitive'));
});

test('执行被阻断时真实子进程失败，仍输出可供通知读取的诊断', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-output-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'output');
    const moduleUrl = new URL('../community-publication.mjs', import.meta.url).href;
    for (const pending of ['REVIEW_BRANCH_SSH_KEY_REQUIRED', 'REVIEW_BRANCH_WRITE_FAILED', 'STATUS_MERGE_BLOCKED', undefined]) {
        fs.writeFileSync(file, '');
        const result = { pr, pending, head: pending ? undefined : head };
        const source = `import { reportExecution } from ${JSON.stringify(moduleUrl)}; reportExecution(${JSON.stringify(result)}, ${JSON.stringify(context)});`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
            cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 60000,
            env: { ...process.env, GITHUB_OUTPUT: file }, windowsHide: true,
        });
        assert.equal(child.status, pending ? 1 : 0, child.stderr);
        const outputs = Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
            const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
        }));
        assert.equal(outputs.head, pending ? '' : head);
        const [projection] = JSON.parse(outputs.projections);
        assert.deepEqual(projection.execution, { runId: '91', attempt: 2 });
        if (pending) assert(projection.summary.startsWith(pending + '\n'));
    }
});
