// 历史 schemaVersion 2 渠道的 SDK 引用校验；最后一个此类渠道停止支持后可移除。
const SDK_MAX_BYTES = 192 * 1024 * 1024;
const SDK_FILES_BYTES = 64 * 1024 * 1024;
const required = ['tools/sdk-tools.jar', 'tools/community-contract.json', 'tools/build-model.mjs',
    'tools/community-model.gradle', 'contracts/community/v1/bundle-manifest.json', 'contracts/community/v1/community.schema.json'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.sort().join(',');
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);

// 只校验历史签名清单中的固定引用，不读取或执行旧 SDK。
export function validateSdk(sdk) {
    if (!exact(sdk, ['version', 'sourceCommit', 'archive', 'files'])
        || typeof sdk.version !== 'string' || !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.?[1-9]\d*)?$/u.test(sdk.version)
        || typeof sdk.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(sdk.sourceCommit) || /^0+$/u.test(sdk.sourceCommit)
        || !exact(sdk.archive, ['file', 'size', 'sha256'])
        || sdk.archive.file !== `PixivDownloader-Plugin-SDK-${sdk.version}.zip`
        || !Number.isSafeInteger(sdk.archive.size) || sdk.archive.size < 1 || sdk.archive.size > SDK_MAX_BYTES
        || !sha256(sdk.archive.sha256) || !Array.isArray(sdk.files) || !sdk.files.length || sdk.files.length > 256) {
        throw new Error('SDK_MANIFEST_INVALID');
    }
    const seen = new Set();
    let total = 0;
    for (const file of sdk.files) {
        if (!exact(file, ['path', 'size', 'sha256']) || typeof file.path !== 'string' || file.path.length > 512
            || !/^[A-Za-z0-9._/-]+$/u.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..')
            || !(required.includes(file.path) || file.path.startsWith('contracts/community/v1/'))
            || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 1
            || (total += file.size) > SDK_FILES_BYTES || !sha256(file.sha256)) throw new Error('SDK_MANIFEST_INVALID');
        seen.add(file.path.toLowerCase());
    }
    if (required.some(file => !seen.has(file))) throw new Error('SDK_MANIFEST_INVALID');
    return sdk;
}
