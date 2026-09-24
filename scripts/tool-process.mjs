import { spawnSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT } from './github.mjs';

// 参数、stdin 和原始诊断只留在执行端，界面只读取下面白名单内的字段。
export function runTool(command, args, { cwd, input, timeout = API_TIMEOUT, maxBuffer = API_BYTES } = {}) {
    const result = spawnSync(command, args, {
        cwd, input, encoding: 'utf8', windowsHide: true, timeout, maxBuffer,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !/TOKEN|SECRET|PRIVATE_KEY|SSH_KEY|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH/iu.test(key))),
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return result;
    const code = { ENOENT: 'TOOL_NOT_FOUND', EACCES: 'TOOL_ACCESS_DENIED', EPERM: 'TOOL_ACCESS_DENIED',
        ETIMEDOUT: 'TOOL_TIMEOUT', ENOBUFS: 'TOOL_OUTPUT_LIMIT_EXCEEDED' }[result.error?.code]
        ?? /(?:Exception|Error): ([A-Z][A-Z0-9_]+)(?:[\s:]|$)/u.exec(result.stderr ?? '')?.[1]
        ?? (result.signal ? 'TOOL_INTERRUPTED' : 'TOOL_EXECUTION_FAILED');
    throw Object.assign(new Error(code), { tool: command, status: result.status, signal: result.signal,
        stdout: result.stdout, stderr: result.stderr, ...(result.error ? { cause: result.error } : {}) });
}

export function checkJavaTools(execute = runTool) {
    for (const tool of ['java', 'javac', 'jar']) {
        // -J-version 在旧 jar 上也可用；先读版本，不用新语法探测旧工具。
        const result = execute(tool, [tool === 'jar' ? '-J-version' : '-version']);
        const version = /(?:version\s+"|javac\s+)([0-9]+(?:[._][0-9]+)*(?:[-+][A-Za-z0-9.-]+)?)/u
            .exec(result.stdout + '\n' + result.stderr)?.[1];
        if (!version) throw Object.assign(new Error('JDK_VERSION_UNRECOGNIZED'), { tool });
        const major = Number(version.split(/[._+-]/u)[version.startsWith('1.') ? 1 : 0]);
        if (major < 17) throw Object.assign(new Error('JDK_VERSION_UNSUPPORTED'), { tool, toolVersion: version });
    }
}

export function toolJson(output) {
    try { return JSON.parse(output); }
    catch { throw Object.assign(new Error('TOOL_OUTPUT_INVALID'), { tool: 'java' }); }
}

export function toolDetails(error) {
    if (!['java', 'javac', 'jar', 'git'].includes(error.tool)) return {};
    const exitCode = error.status ?? error.exitCode;
    return { tool: error.tool,
        ...(/^[0-9]+(?:[._][0-9]+)*(?:[-+][A-Za-z0-9.-]+)?$/u.test(error.toolVersion ?? '')
            && error.toolVersion.length <= 64 ? { toolVersion: error.toolVersion } : {}),
        ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}) };
}
