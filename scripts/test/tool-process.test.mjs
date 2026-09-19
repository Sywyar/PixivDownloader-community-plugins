import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool, checkJavaTools, toolJson } from '../tool-process.mjs';
import { failureCode, failureDetails, locales, localizedText } from '../submission-ui.mjs';
import { errors } from '../submission-messages.mjs';
import { formatMetadata } from '../submission-presentation.mjs';
import { observe } from '../submission-progress.mjs';
import { prepareSdk } from '../sdk.mjs';

test('Java 三个入口逐一检查最低版本，旧 JDK 不进入解包和编译', () => {
    for (const rejected of ['java', 'javac', 'jar']) {
        const calls = [];
        assert.throws(() => checkJavaTools((tool, args) => {
            calls.push(tool);
            assert.deepEqual(args, [tool === 'jar' ? '-J-version' : '-version']);
            const version = tool === rejected ? '1.8.0_401' : '21.0.2';
            return { stdout: tool === 'javac' ? `javac ${version}` : '', stderr: tool !== 'javac' ? `openjdk version "${version}"` : '' };
        }), error => error.message === 'JDK_VERSION_UNSUPPORTED' && error.tool === rejected && error.toolVersion === '1.8.0_401');
        assert.equal(calls.at(-1), rejected);
    }
    assert.throws(() => checkJavaTools(() => ({ stdout: 'secret invalid output', stderr: '' })), /JDK_VERSION_UNRECOGNIZED/u);
    checkJavaTools(tool => ({ stdout: tool === 'javac' ? 'javac 26-ea' : '', stderr: tool === 'javac' ? '' : 'java version "17.0.12"' }));
    checkJavaTools();
});

test('真实子进程的缺失、超时、超限、非零退出和合同拒绝分别保留机器码', () => {
    assert.throws(() => runTool(path.join(os.tmpdir(), 'missing-tool-' + process.pid), []), /TOOL_NOT_FOUND/u);
    assert.throws(() => runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /TOOL_TIMEOUT/u);
    assert.throws(() => runTool(process.execPath, ['-e', 'process.stdout.write("x".repeat(65536))'], { maxBuffer: 100 }), /TOOL_OUTPUT_LIMIT_EXCEEDED/u);
    assert.throws(() => runTool(process.execPath, ['-e', 'console.error("secret"); process.exit(7)']), error =>
        error.message === 'TOOL_EXECUTION_FAILED' && error.status === 7 && !error.message.includes('secret'));
    assert.throws(() => runTool(process.execPath, ['-e', 'console.error("Exception: KEY_PASSWORD_INVALID: secret"); process.exit(1)']), /KEY_PASSWORD_INVALID/u);
    assert.deepEqual(toolJson(runTool(process.execPath, ['-e', 'console.log("{\\"ok\\":true}")']).stdout), { ok: true });
    assert.throws(() => toolJson('warning with secret\n{"ok":true}'), /TOOL_OUTPUT_INVALID/u);
});

test('诊断只投影受控字段，嵌套失败保留实际步骤并支持全部语言', async () => {
    const error = Object.assign(new Error('TOOL_EXECUTION_FAILED'), { tool: 'javac', status: 7,
        stderr: 'secret', stdout: 'secret', password: 'secret', spawnargs: ['secret'] });
    await assert.rejects(observe('preparing', '', async () => observe('tool_javac', '', () => { throw error; })),
        actual => actual === error && error.failureStep === 'tool_javac');
    const details = failureDetails(error);
    assert.deepEqual(details, { tool: 'javac', exitCode: 7, failureStep: 'tool_javac' });
    assert.deepEqual(failureDetails(details), details);
    assert.deepEqual(failureDetails({ tool: 'secret', toolVersion: 'secret', failureStep: 'secret' }), {});
    for (const [index, locale] of locales.entries()) {
        const text = key => localizedText(locale, key);
        assert(formatMetadata(details, text).includes(text('tool_javac')));
        assert(!JSON.stringify(details).includes('secret'));
        for (const code of ['JDK_VERSION_UNSUPPORTED', 'JDK_VERSION_UNRECOGNIZED', 'TOOL_NOT_FOUND', 'TOOL_TIMEOUT',
            'TOOL_EXECUTION_FAILED', 'TOOL_OUTPUT_INVALID', 'LOCAL_FILE_MISSING']) assert(errors[code][index]);
    }
    for (const [code, expected] of [['ENOENT', 'LOCAL_FILE_MISSING'], ['EPERM', 'LOCAL_ACCESS_DENIED'], ['ENOSPC', 'LOCAL_STORAGE_FULL']]) {
        assert.equal(failureCode(Object.assign(new Error('secret'), { code })), expected);
    }
});

test('真实 SDK 编译和运行失败明确工具与步骤，保留原始内部诊断', t => {
    const sdk = prepareSdk();
    t.after(() => fs.rmSync(sdk.workspace, { recursive: true, force: true }));
    assert.throws(() => sdk.run('javac', ['--release', '0']), error => {
        assert.equal(failureCode(error), 'TOOL_EXECUTION_FAILED');
        assert.equal(failureDetails(error).tool, 'javac');
        assert.equal(failureDetails(error).failureStep, 'tool_javac');
        assert.notEqual(error.status, 0);
        assert(error.stderr.length > 0);
        return true;
    });
    assert.throws(() => sdk.invoke('not-a-command'), error => failureCode(error) !== 'SUBMISSION_FAILED');
});
