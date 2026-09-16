import { isDeepStrictEqual } from 'node:util';
import { recoverableRequest } from './submission-github.mjs';

// 工具临时路径和 Buffer 不属于选择身份；恢复后返回本次重新读取的对象。
const selectionIdentity = value => value?.candidate ? { candidate: value.candidate }
    : value?.value && value?.sha256 ? { path: value.path, sha256: value.sha256 } : value;
const freshConfirmation = new Set(['preview', 'rerunCandidate', 'waitCandidate', 'representation', 'transfer', 'withdrawConfirm', 'licenseTemplate', 'deleteRequestBranch', 'retryBranchCleanup']);

export function unavailable(ui, code, details = {}) {
    ui.say('operationUnavailable', { code, ...details });
    throw new Error('WIZARD_MENU');
}

export function navigation(ui, getStore = () => null, { history = [], onChange = () => {}, onBack = () => {}, onMenu = () => {}, onFailure } = {}) {
    const answers = structuredClone(history);
    let cursor = 0;
    let replay = answers.length;
    let counts = new Map();
    let sealed = false;
    const wrapped = { ...ui };
    for (const method of ['ask', 'select', 'multiselect', 'confirm', 'password']) {
        wrapped[method] = async (key, ...args) => {
            if (method === 'password' || key === 'retrySubmission' || key === 'revokeIdentity') return ui[method](key, ...args);
            const index = cursor++;
            const count = counts.get(key) ?? 0;
            counts.set(key, count + 1);
            const field = `${key}:${count}`;
            const store = getStore();
            const scope = ['operation', 'project', 'profile', 'candidate'].includes(key) ? null : store?.folder ?? null;
            const signature = [method, key, method === 'ask' || method === 'confirm' && freshConfirmation.has(key)
                ? null : method === 'select' ? args[0].map(selectionIdentity) : args[0], scope];
            const previous = answers[index];
            // 拒绝确认表示停在此处，不是下次恢复时再次取消的指令。
            if (!(method === 'confirm' && (freshConfirmation.has(key) || previous?.value !== true))
                && index < replay && previous && isDeepStrictEqual(previous.signature, signature)) {
                let valid = true;
                if (method === 'select' && !args[0].some(value => isDeepStrictEqual(selectionIdentity(value), previous.value))) valid = false;
                if (method === 'ask' && args[1]) {
                    try { await args[1](previous.value); } catch { valid = false; }
                }
                if (valid) return method === 'select' ? args[0].find(value => isDeepStrictEqual(selectionIdentity(value), previous.value)) : previous.value;
            }
            if (!(method === 'confirm' && freshConfirmation.has(key))) replay = Math.min(replay, index);
            const remembered = previous?.field === field && previous.scope === scope ? previous.value : scope ? store?.answer(field) : undefined;
            if (method === 'ask' && remembered !== undefined) args[0] = remembered;
            if (method === 'select' && remembered !== undefined) {
                args[2] = args[0].find(value => isDeepStrictEqual(selectionIdentity(value), remembered));
            }
            if (method === 'multiselect' && Array.isArray(remembered)) args[1] = remembered;
            const value = await ui[method](key, ...args);
            answers[index] = { field, scope, signature: structuredClone(signature), value: structuredClone(method === 'select' ? selectionIdentity(value) : value) };
            if (!['confirm', 'password'].includes(method)) store?.remember(field, value);
            if (key !== 'preview') onChange(answers.slice(0, Math.max(cursor, replay)).map(answer => answer?.signature[0] === 'confirm' && freshConfirmation.has(answer.signature[1])
                ? { ...answer, value: undefined } : answer));
            return value;
        };
    }
    return { ui: wrapped, seal() { sealed = true; }, async run(work) {
        for (;;) {
            cursor = 0; counts = new Map();
            try { return await work(wrapped); }
            catch (error) {
                if (recoverableRequest(error) && onFailure && await onFailure(error)) { replay = answers.length; continue; }
                if (!sealed && error.message === 'WIZARD_MENU') {
                    answers.length = 0; replay = 0; onMenu(); onChange([]); continue;
                }
                if (sealed || error.message !== 'WIZARD_BACK') throw error;
                onBack();
                replay = Math.max(0, cursor - 2);
            }
        }
    } };
}
