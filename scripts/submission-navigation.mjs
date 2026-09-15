import { isDeepStrictEqual } from 'node:util';

// 返回时重算表单派生值；只有本次会话中内容完全相同的已答问题可重放。
// 确认结果不写历史，外部操作仅在最末确认和重新核验之后执行。
export function navigation(ui, getStore = () => null) {
    const answers = [];
    let cursor = 0;
    let replay = 0;
    let counts = new Map();
    let sealed = false;
    const wrapped = { ...ui };
    for (const method of ['ask', 'select', 'multiselect', 'confirm', 'password']) {
        wrapped[method] = async (key, ...args) => {
            const index = cursor++;
            const count = counts.get(key) ?? 0;
            counts.set(key, count + 1);
            const field = `${key}:${count}`;
            const store = getStore();
            const scope = ['operation', 'project', 'profile', 'candidate'].includes(key) ? null : store?.folder ?? null;
            const signature = [method, key, ['ask', 'password'].includes(method) ? null : args[0], scope];
            const previous = answers[index];
            if (method !== 'password' && index < replay && previous && isDeepStrictEqual(previous.signature, signature)) {
                let valid = true;
                if (method === 'ask' && args[1]) {
                    try { await args[1](previous.value); } catch { valid = false; }
                }
                if (valid) return previous.value;
            }
            replay = Math.min(replay, index);
            const remembered = previous?.field === field && previous.scope === scope ? previous.value : scope ? store?.answer(field) : undefined;
            if (method === 'ask' && remembered !== undefined) args[0] = remembered;
            if (method === 'select' && remembered !== undefined) {
                args[2] = args[0].find(value => isDeepStrictEqual(value, remembered));
            }
            if (method === 'multiselect' && Array.isArray(remembered)) args[1] = remembered;
            const value = await ui[method](key, ...args);
            answers[index] = { field, scope, signature: structuredClone(signature), value: method === 'password' ? undefined : structuredClone(value) };
            if (!['confirm', 'password'].includes(method)) store?.remember(field, value);
            return value;
        };
    }
    return { ui: wrapped, seal() { sealed = true; }, async run(work) {
        for (;;) {
            cursor = 0; counts = new Map();
            try { return await work(wrapped); }
            catch (error) {
                if (sealed || error.message !== 'WIZARD_BACK') throw error;
                replay = Math.max(0, cursor - 2);
            }
        }
    } };
}
