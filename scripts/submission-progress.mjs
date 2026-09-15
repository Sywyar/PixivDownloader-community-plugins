// 终端线程只接收受控步骤名与公开资源名称，不接收子进程参数或输出。
let report = () => {};
export function progressReporter(listener) { report = listener; }
export function observe(step, detail, work) {
    report({ step, detail, active: true });
    try { return work(); }
    finally { report({ step, detail, active: false }); }
}
