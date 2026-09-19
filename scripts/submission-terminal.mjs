import { Worker } from 'node:worker_threads';
import { terminal, localizedText, failureCode, failureDetails } from './submission-ui.mjs';
import { progressReporter } from './submission-progress.mjs';
import { visible, optionText } from './submission-presentation.mjs';
import { requestDetails } from './submission-github.mjs';

const failure = error => ({ message: failureCode(error), ...failureDetails(error),
    ...(requestDetails(error).stage ? { downloadStage: requestDetails(error).stage } : {}) });

// 单个可信业务线程执行既有同步工具，终端线程继续处理绘制、验证与取消。
export async function workerTerminal(port, cancelled, options) {
    let sequence = 0;
    const pending = new Map();
    const validators = new Map();
    const controller = new AbortController();
    const request = (method, args = [], validate) => new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        if (validate) validators.set(id, validate);
        port.postMessage({ id, method, args, validate: Boolean(validate) });
    });
    port.on('message', async message => {
        if (message.method === 'cancel') { controller.abort(); return; }
        if (message.method === 'validate') {
            try { await validators.get(message.prompt)?.(message.value); port.postMessage({ validation: message.id }); }
            catch (error) { port.postMessage({ validation: message.id, error: failure(error) }); }
            return;
        }
        const waiting = pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id); validators.delete(message.id);
        if (message.error) waiting.reject(Object.assign(new Error(message.error.message), message.error));
        else waiting.resolve(message.value);
    });
    const { locale, resume } = await request('open', [options]);
    const ui = { locale, resume, signal: controller.signal, text: key => localizedText(locale, key),
        retryRequest(error, retryRound) {
            const gate = new Int32Array(new SharedArrayBuffer(4));
            port.postMessage({ method: 'retryRequest', gate, args: [{ code: failureCode(error), retryRound,
                ...requestDetails(error), ...failureDetails(error) }] });
            Atomics.wait(gate, 0, 0);
            if (Atomics.load(gate, 0) === 1) return true;
            throw new Error(Atomics.load(gate, 0) === 3 ? 'CANCELLED' : 'WIZARD_SAVE');
        },
        ask: (key, initial, validate) => request('ask', [key, initial], validate),
        password: (key, validate) => request('password', [key], validate),
        async select(key, values, label = value => optionText(value, ui.text), initial) {
            const index = await request('select', [key, values.map(label), values.indexOf(initial)]);
            return values[index];
        },
        multiselect: (key, values, initial) => request('multiselect', [key, values, initial]),
        confirm: (key, value) => request('confirm', [key, value]),
        say: (key, value) => port.postMessage({ method: 'say', args: [key, value] }),
        async task(key, work) {
            const id = await request('task', [key]);
            try { const result = await work(); port.postMessage({ task: id }); return result; }
            catch (error) { error.failureStep ??= key; port.postMessage({ task: id, error: failure(error) }); throw error; }
        },
        close: () => { progressReporter(() => {}); port.postMessage({ method: 'close' }); },
    };
    const progress = [];
    progressReporter(value => {
        if (value.active && Atomics.load(cancelled, 0)) throw new Error('CANCELLED');
        if (value.active) progress.push(value); else progress.pop();
        port.postMessage({ method: 'progress', value: progress.at(-1) ?? { active: false } });
    });
    return ui;
}

export function connectTerminal(worker, cancelled, input = process.stdin, output = process.stdout) {
    let ui;
    let busy;
    let prompting = false;
    let sequence = 0;
    const tasks = new Map();
    const validations = new Map();
    const clear = () => { busy?.clear(); busy = null; };
    const validate = prompt => value => new Promise((resolve, reject) => {
        const id = ++sequence; validations.set(id, { resolve, reject });
        worker.postMessage({ method: 'validate', id, prompt, value });
    });
    return new Promise((resolve, reject) => {
        worker.on('message', async message => {
            if (message.validation) {
                const pending = validations.get(message.validation); validations.delete(message.validation);
                if (message.error) pending?.reject(Object.assign(new Error(message.error.message), message.error)); else pending?.resolve();
                return;
            }
            if (message.task) {
                const pending = tasks.get(message.task); tasks.delete(message.task);
                if (message.error) pending?.reject(Object.assign(new Error(message.error.message), message.error)); else pending?.resolve();
                return;
            }
            try {
                const { method, args = [] } = message;
                if (method === 'open') {
                    ui = await terminal(input, output, args[0]);
                    ui.signal.addEventListener('abort', () => { Atomics.store(cancelled, 0, 1); worker.postMessage({ method: 'cancel' }); });
                    worker.postMessage({ id: message.id, value: { locale: ui.locale, resume: ui.resume } }); return;
                }
                if (method === 'progress') {
                    if (prompting) return;
                    if (tasks.size) { if (message.value.active) for (const task of tasks.values()) task.update(message.value.step, message.value.detail); }
                    else if (message.value.active) {
                        if (busy) busy.message(ui.text(message.value.step) + (message.value.detail ? ' · ' + visible(message.value.detail) : ''));
                        else busy = ui.activity(message.value.step, message.value.detail);
                    }
                    else clear();
                    return;
                }
                if (method === 'say') { clear(); ui.say(...args); return; }
                if (method === 'retryRequest') {
                    let answer = 3;
                    try {
                        clear();
                        for (const task of tasks.values()) task.update.pause();
                        ui.say('requestFailed', args[0]);
                        answer = await ui.select('retryCurrentStep', ['retry', 'saveExit'], key => ui.text(key), undefined, { back: false }) === 'retry' ? 1 : 2;
                    } catch (error) {
                        if (error.message === 'WIZARD_SAVE') answer = 2;
                        else throw error;
                    } finally {
                        Atomics.store(message.gate, 0, answer);
                        Atomics.notify(message.gate, 0);
                        if (answer === 1) for (const task of tasks.values()) task.update.resume();
                    }
                    return;
                }
                if (method === 'close') { clear(); ui.close(); return; }
                if (method === 'result') { resolve(args[0]); return; }
                clear();
                if (method === 'task') {
                    ui.task(args[0], update => new Promise((resolve, reject) => {
                        tasks.set(message.id, { resolve, reject, update });
                        worker.postMessage({ id: message.id, value: message.id });
                    })).catch(() => {});
                    return;
                }
                prompting = true;
                let value;
                try {
                    if (method === 'ask') value = await ui.ask(...args, message.validate ? validate(message.id) : undefined);
                    else if (method === 'password') value = await ui.password(...args, message.validate ? validate(message.id) : undefined);
                    else if (method === 'select') value = await ui.select(args[0], args[1].map((_, i) => i), i => args[1][i], args[2]);
                    else if (method === 'multiselect' || method === 'confirm') value = await ui[method](...args);
                    else throw new Error('TERMINAL_PROTOCOL_INVALID');
                } finally { prompting = false; }
                worker.postMessage({ id: message.id, value });
            } catch (error) { worker.postMessage({ id: message.id, error: failure(error) }); }
        });
        worker.once('error', error => { clear(); ui?.close(); reject(new Error(failureCode(error))); });
        worker.once('exit', code => {
            clear(); ui?.close();
            for (const pending of [...tasks.values(), ...validations.values()]) pending.reject(new Error('SUBMISSION_WORKER_EXITED'));
            if (code !== 0) reject(new Error('SUBMISSION_WORKER_EXITED'));
            else resolve({ failed: 'SUBMISSION_WORKER_EXITED' });
        });
    });
}

export function runInteractive(directory) {
    const cancelled = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('./submission-worker.mjs', import.meta.url), { workerData: { directory, cancelled } });
    return connectTerminal(worker, cancelled);
}
