export const visible = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/gu,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

export function optionText(value, text) {
    const key = 'option.' + value, label = text(key);
    return label === key ? String(value) : `${label} (${value})`;
}

const labels = {
    pluginId: 'plugin', publisherId: 'publisher', displayName: 'name', defaultLocale: 'locale', expression: 'license',
    projectDir: 'project', profileId: 'profile', privateFile: 'privateKey', publicFile: 'publicKey',
    package: 'artifact', source: 'sourceLabel', repository: 'repositoryLabel', commit: 'commitLabel',
    expectedSize: 'sizeLabel', size: 'sizeLabel', sha256: 'digestLabel', fingerprint: 'fingerprintLabel',
    publicKeySpkiBase64: 'publicKeyLabel', executionMode: 'executionLabel', riskDeclaration: 'riskLabel',
    signals: 'riskLabel', path: 'pathLabel', accountId: 'accountLabel', accountType: 'accountTypeLabel',
    url: 'urlLabel', html_url: 'urlLabel', version: 'versionLabel', title: 'titleLabel',
    buildProfile: 'profile', license: 'license', market: 'marketLabel', key: 'keyAction', owner: 'owner',
    code: 'errorCodeLabel', stage: 'stageLabel', branch: 'branchLabel', base: 'commitLabel',
    status: 'statusLabel', attempts: 'attemptsLabel', head: 'commitLabel', repositoryId: 'repositoryLabel',
    directory: 'directoryLabel', protection: 'keyProtection', present: 'presentLabel', algorithm: 'algorithmLabel',
    dependencies: 'dependenciesLabel', reasonCode: 'reason', mode: 'mode', role: 'roleLabel',
    from: 'option.FROM', to: 'option.TO',
};

export function formatMetadata(value, text, depth = 0, field = '') {
    if (value === null || value === undefined) return text('none');
    if (typeof value === 'boolean') return text(value ? 'yes' : 'no');
    if (typeof value !== 'object') return visible(['reasonCode', 'mode', 'role', 'accountType', 'executionMode', 'category', 'tags', 'signals'].includes(field)
        ? optionText(value, text) : ['protection', 'branchCleanup'].includes(field) ? text(value) : value);
    if (depth > 12) return text('details');
    return Object.entries(value).flatMap(([key, item]) => {
        if (/password|passphrase|privateKeySpki|token|secret/iu.test(key)) return [];
        // 签名及完整公钥仍在技术详情中可查；确认界面展示其身份和指纹。
        if (key === 'value' && value.algorithm === 'Ed25519' || key === 'publicKeySpkiBase64') return [];
        const label = Array.isArray(value) ? String(Number(key) + 1) : text(labels[key] ?? key);
        const childField = Array.isArray(value) ? field : key;
        if (item && typeof item === 'object') return [`${'  '.repeat(depth)}${visible(label)}`, formatMetadata(item, text, depth + 1, childField)];
        return [`${'  '.repeat(depth)}${visible(label)}: ${formatMetadata(item, text, depth + 1, childField)}`];
    }).join('\n');
}

export function previewMetadata(preview) {
    const submission = preview.result?.submission;
    return { ...(submission ? { pluginId: submission.pluginId, version: submission.version, source: submission.source,
        buildProfile: submission.buildProfile, license: submission.license, market: submission.market,
        package: { url: submission.package.url, size: submission.package.expectedSize, sha256: submission.package.sha256 },
        owner: preview.result.owner, fingerprint: preview.result.publisherKeyFingerprint,
        riskDeclaration: preview.result.descriptor } : { result: preview.result }),
        ...(preview.result?.sourceRelease ? { candidate: preview.result.sourceRelease } : {}),
        ...(preview.result?.changes?.length ? { changes: preview.result.changes } : {}),
        files: preview.files?.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
}

export function metadataChanges(previous, current) {
    return Object.keys({ ...previous, ...current }).filter(key => JSON.stringify(previous?.[key]) !== JSON.stringify(current?.[key]))
        .map(field => ({ field, before: previous?.[field] ?? null, after: current?.[field] ?? null }));
}
