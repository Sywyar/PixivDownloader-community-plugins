import { api, id, sha, list, prefix, policy } from './github.mjs';
import { hash } from './sdk.mjs';
import { repositoryTree, readBlob } from './submission-github.mjs';
import { optionNames } from './submission-messages.mjs';
import { updateRequestLabels } from './sync-labels.mjs';

export const COMMENT_BYTES = 65536;
export const REQUEST_INFO_MARKER = '<!-- community-request-info -->';
const requestInfoMarkers = { 'zh-CN': REQUEST_INFO_MARKER, 'en-US': '<!-- community-request-info:en-US -->' };
const operations = {
    FIRST_RELEASE: [['首次发布', 'First release'], 'SUBMISSION'],
    UPDATE: [['更新版本', 'Version update'], 'SUBMISSION'],
    KEY_ROTATION: [['更换发布者签名密钥', 'Publisher key rotation'], 'ROTATION'],
    YANK: [['隐藏版本', 'Yank version'], 'STATUS_REQUEST'],
    UNYANK: [['恢复隐藏版本', 'Restore yanked version'], 'STATUS_REQUEST'],
    REVOKE: [['撤销版本', 'Revoke version'], 'STATUS_REQUEST'],
    OWNERSHIP_TRANSFER: [['转移插件所有权', 'Ownership transfer'], 'TRANSFER'],
    DECLARE_KEY_COMPROMISE: [['声明签名密钥泄露', 'Declare key compromise'], 'EMERGENCY_REQUEST'],
};

// 请求文本只作展示；转义 Markdown、HTML、提及及双向控制字符，不解释为机器人指令。
const text = value => String(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/[&<>"'`\\|!*_\[\]()~@#]/gu, value => `&#${value.codePointAt(0)};`).replace(/\n/gu, '<br>');
const owner = value => `${value.publisherId} · ${value.accountType} #${value.accountId}`;

// 仅在请求已通过合同、身份和签名校验后调用；字段来自原始请求，不读取 PR 正文。
export function formatRequestInfo(checked, request, pr, details = {}) {
    if (!operations[checked.operation]) return undefined;
    return Object.fromEntries(Object.keys(requestInfoMarkers).map((locale, index) =>
        [locale, localizedRequestInfo(checked, request, pr, details, locale, index)]));
}

function localizedRequestInfo(checked, request, pr, { approvals = [], ownerLogin }, locale, index) {
    const operation = operations[checked.operation];
    const language = values => values[index];
    const option = code => optionNames[code] ? `${optionNames[code][index]} (${code})` : code;
    const proof = (value, keyId) => language(value ? ['已验证签名', 'Signature verified'] : ['未提供签名证明', 'No signature proof'])
        + (keyId ? ' · keyId: ' + keyId : '');
    const p = request.payload, rows = [[language(['操作', 'Operation']), `${language(operation[0])} (${checked.operation})`],
        [language(['申请账号', 'Request author']), `${pr.user.login ?? ''} (#${id(pr.user.id)})`]];
    const add = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push([language(label), value]); };
    const file = checked.submissionPath ?? checked.requestPath;
    const digest = checked.submissionSha256 ?? checked.requestSha256;
    const name = pr.head.repo.full_name;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(name) || name.split('/').some(part => part === '.' || part === '..')
        || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error('REQUEST_INFO_SOURCE_INVALID');
    const source = `https://github.com/${name}/blob/${sha(pr.head.sha)}/${file.split('/').map(encodeURIComponent).join('/')}`;
    if (checked.owner) add(['发布者', 'Publisher'], owner(checked.owner));
    add(['插件', 'Plugin'], checked.pluginId && `${checked.pluginId}${checked.version ? '@' + checked.version : ''}`);
    if (operation[1] === 'SUBMISSION') {
        const market = request.market;
        add(['分类', 'Category'], option(market.category));
        add(['简介', 'Summary'], market.summary[locale] ?? market.summary[market.defaultLocale]);
        add(['安装包签名', 'Package signature'], proof(true, request.package.signature.keyId));
        add(['源码', 'Source'], `${request.source.repository} @ ${request.source.commit}`);
        add(['许可证', 'License'], request.license.expression);
        add(['执行模式', 'Execution mode'], checked.descriptor?.executionMode && option(checked.descriptor.executionMode));
    } else if (checked.operation === 'KEY_ROTATION') {
        add(['分类', 'Category'], option(p.reasonCode));
        add(['新钥证明', 'New key proof'], proof(request.proofs.newKey, p.newKey.keyId));
        add(['旧钥证明', 'Previous key proof'], proof(request.proofs.oldKey, p.oldKeyId));
    } else if (operation[1] === 'STATUS_REQUEST') {
        add(['分类', 'Category'], option(p.reasonCode));
        add(['活动密钥证明', 'Active key proof'], proof(request.proofs.activeKey, request.proofs.activeKey?.keyId));
    } else if (checked.operation === 'OWNERSHIP_TRANSFER') {
        add(['分类', 'Category'], option(p.mode));
        add(['原所有者', 'Previous owner'], owner(p.from));
        add(['新所有者', 'New owner'], owner(p.to));
        add(['接收方密钥证明', 'Recipient key proof'], proof(request.proofs.targetKey, p.targetKey.keyId));
        add(['申请文件中的确认角色', 'Confirmations in request files'], approvals.map(value => `${option(value.role)} · #${value.accountId}`).join('\n'));
        if (p.recoveryEvidence) add(['恢复证据数量', 'Recovery evidence count'], p.recoveryEvidence.length);
    } else {
        add(['身份验证', 'Identity verification'], language(['GitHub 账号权限已核验；此操作不要求私钥证明', 'GitHub authority verified; no private-key proof required']));
        add(['声明密钥数量', 'Declared key count'], p.keys.length);
    }
    add(['申请原因', 'Request explanation'], p?.explanation);
    const handoff = checked.operation === 'OWNERSHIP_TRANSFER' && checked.singlePr
        ? `\n\n${ownerLogin ? '@' + ownerLogin + ' ' : ''}${language([
            '原所有者：请运行向导在本 PR 确认或拒绝。不同个人账号提供双方有效密钥证明后可自动处理；网页 Approve 或缺少证明仍需维护者审核。不要先合并申请。',
            'Current owner: use the wizard to approve or reject this PR. Distinct personal accounts with valid proofs from both keys can use automatic processing; web approval or missing proof still requires maintainer review. Keep the request open until completion.',
        ])}\n`
        : '';
    const note = handoff + '\n\n' + language(['此评论展示请求内容及本次验签结果；审核和执行进度见状态评论或检查。',
        'This comment describes the request and its signature verification; see the status comment or checks for review and execution.']) + '\n';
    const reference = `\n[${language(['请求原文', 'Request source'])}](${source}) · SHA-256: \`${digest}\`\n`;
    const overflow = '\n' + language(['部分条目因评论长度限制未展开，请查看请求原文。', 'Some entries exceed the comment limit; see the request source.']) + '\n';
    let body = `### ${language(['请求信息', 'Request information'])}\n\n| ${language(['字段', 'Field'])} | ${language(['内容', 'Value'])} |\n| --- | --- |\n`;
    const extra = checked.operation === 'DECLARE_KEY_COMPROMISE' ? p.keys.map(key =>
        [language(['泄露密钥', 'Compromised key']), `keyId: ${key.keyId}\nSHA-256: ${key.fingerprint}`]) : [];
    for (const [label, value] of [...rows, ...extra]) {
        const row = `| ${text(label)} | ${text(value)} |\n`;
        // 两种语言通过同一个 Actions 环境变量传递，共用原展示预算并计入 JSON 转义。
        const header = `${requestInfoMarkers[locale]}\nHead: ${pr.head.sha}\n\n`;
        if (Buffer.byteLength(JSON.stringify(header + body + row + note + reference + overflow), 'utf8') > COMMENT_BYTES / 2) {
            body += overflow; break;
        }
        body += row;
    }
    return body + note + reference;
}

export function readRequestInfo(sdk, checked, pr, call = api) {
    const operation = operations[checked?.operation];
    if (!operation) return undefined;
    if (checked.validation !== 'STATIC_VALIDATED') throw new Error('REQUEST_INFO_UNVERIFIED');
    const tree = repositoryTree(pr.head.repo.full_name, pr.head.sha, call);
    const file = checked.submissionPath ?? checked.requestPath;
    const bytes = readBlob(pr.head.repo.full_name, tree.get(file), call);
    if (hash(bytes) !== (checked.submissionSha256 ?? checked.requestSha256)) throw new Error('REQUEST_INFO_CHANGED');
    const request = sdk.document(operation[1], bytes, file).value;
    const approvals = checked.operation === 'OWNERSHIP_TRANSFER' ? list(`${prefix}/pulls/${id(pr.number)}/files`, null, call)
        .map(row => /^ownership-transfers\/[^/]+\/[a-f0-9]{64}\/approvals\/(from|to)\/([1-9][0-9]*)\.json$/u.exec(row.filename))
        .filter(Boolean).map(match => ({ role: match[1].toUpperCase(), accountId: match[2] })) : [];
    let ownerLogin;
    if (checked.operation === 'OWNERSHIP_TRANSFER' && checked.singlePr && checked.from.accountType === 'User') {
        const account = call(`user/${id(checked.from.accountId)}`);
        if (id(account.id) !== checked.from.accountId || account.type !== 'User' || !/^[A-Za-z0-9-]+$/u.test(account.login)) {
            throw new Error('TRANSFER_OWNER_IDENTITY_CHANGED');
        }
        ownerLogin = account.login;
    }
    return formatRequestInfo(checked, request, pr, { approvals, ownerLogin });
}

export function updateComment(number, marker, body, matches, call = api) {
    if (typeof body !== 'string') throw new Error('SUMMARY_PROJECTION_INVALID');
    if (Buffer.byteLength(body, 'utf8') > COMMENT_BYTES) throw new Error('SUMMARY_PROJECTION_SIZE');
    const comments = list(`${prefix}/issues/${id(number)}/comments`, null, call).filter(comment =>
        comment.user?.type === 'Bot' && id(comment.user.id) === '41898282' && comment.body?.startsWith(marker));
    if (comments.length > 1) throw new Error('SUMMARY_COMMENT_AMBIGUOUS');
    if (!matches()) return;
    if (comments.length) {
        if (comments[0].body !== body) call(`${prefix}/issues/comments/${id(comments[0].id)}`, { method: 'PATCH', body: { body } });
    } else call(`${prefix}/issues/${id(number)}/comments`, { method: 'POST', body: { body } });
}

export function notifyRequestInfo(projection, call = api) {
    if (!projection || projection.requestInfo === undefined) return;
    const info = projection.requestInfo;
    if (!info || typeof info !== 'object' || Array.isArray(info) || Object.keys(info).length !== 2
        || Object.keys(requestInfoMarkers).some(locale => typeof info[locale] !== 'string')) throw new Error('SUMMARY_PROJECTION_INVALID');
    const bodies = Object.entries(requestInfoMarkers).map(([locale, marker]) => [marker,
        `${marker}\nHead: ${projection.head}\n\n${info[locale]}`]);
    if (bodies.some(([, body]) => Buffer.byteLength(body, 'utf8') > COMMENT_BYTES)) throw new Error('SUMMARY_PROJECTION_SIZE');
    const base = projection.baseRef ?? policy.defaultBranch;
    if (![policy.defaultBranch, policy.emergencyBranch].includes(base)) throw new Error('PR_TARGET_INVALID');
    const matches = () => {
        const pr = call(`${prefix}/pulls/${id(projection.number)}`);
        return pr.number === Number(projection.number) && id(pr.base.repo.id) === policy.repositoryId
            && pr.base.ref === base
            && pr.head.sha === sha(projection.head) && pr.state === projection.state && pr.merged === projection.merged;
    };
    if (!matches()) return;
    if (projection.operationLabels !== undefined) updateRequestLabels(projection.number, { operations: projection.operationLabels }, call);
    for (const [marker, body] of bodies) updateComment(projection.number, marker, body, matches, call);
}
