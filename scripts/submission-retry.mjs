import { observe } from './submission-progress.mjs';

// 仅交互 worker 安装同步恢复入口；CI 和非交互调用保留原来的失败行为。
let recover;
export function requestRecovery(handler) {
    const previous = recover;
    recover = handler;
    return () => { recover = previous; };
}
export function retryRequest(error, round) {
    if (!recover) throw error;
    return recover(error, round);
}

// 写入调用方必须在 work 中回读同一对象，确认未生效后才可再次写入。
export async function retryStep(key, work, { retry, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let attempts = 0, round = 1, totalAttempts = 0;
    for (;;) {
        try { return await observe(key, '', work); }
        catch (error) {
            if (!(error.github || error.download && error.retryable)) throw error;
            error.failureStep ??= key;
            attempts += error.attempts ?? 1;
            totalAttempts += error.attempts ?? 1;
            if (error.retryable && !error.download && error.method !== 'GET' && attempts < 3) {
                await observe('retryingGithub', `${attempts + 1}/3`, () => wait(attempts * 1000));
                continue;
            }
            error.retryRound = round++;
            error.attempts = attempts;
            error.totalAttempts = totalAttempts;
            if (!await (retry ? retry(error) : retryRequest(error, error.retryRound))) throw error;
            attempts = 0;
        }
    }
}
