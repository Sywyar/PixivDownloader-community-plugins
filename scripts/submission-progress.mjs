// 终端线程只接收受控步骤名与公开资源名称，不接收子进程参数或输出。
import { AsyncLocalStorage } from 'node:async_hooks';
const steps = new AsyncLocalStorage();
export const currentStep = () => steps.getStore();
let report = () => {};
export function progressReporter(listener) { report = listener; }
export function observe(step, detail, work) {
    return steps.run(step, () => {
        report({ step, detail, active: true });
        const done = () => report({ step, detail, active: false });
        const failed = error => {
            if (error instanceof Error) error.failureStep ??= step;
            throw error;
        };
        let result;
        try { result = work(); }
        catch (error) { done(); return failed(error); }
        if (result?.then) return Promise.resolve(result).catch(failed).finally(done);
        done();
        return result;
    });
}
