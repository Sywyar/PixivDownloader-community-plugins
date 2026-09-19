// 只返回受控机器码；原生命令输出、文件路径和凭据不进入界面。
export const authenticationRequired = code => ['GITHUB_AUTH_REQUIRED', 'GITHUB_AUTH_INVALID'].includes(code);

export const localFailureCode = error => ({
    ENOENT: 'LOCAL_FILE_MISSING', EACCES: 'LOCAL_ACCESS_DENIED', EPERM: 'LOCAL_ACCESS_DENIED', EROFS: 'LOCAL_ACCESS_DENIED',
    ENOSPC: 'LOCAL_STORAGE_FULL', EDQUOT: 'LOCAL_STORAGE_FULL', EIO: 'LOCAL_IO_FAILED',
    EEXIST: 'LOCAL_FILE_EXISTS', EISDIR: 'LOCAL_PATH_TYPE_INVALID', ENOTDIR: 'LOCAL_PATH_TYPE_INVALID',
    ELOOP: 'LOCAL_PATH_LINK_INVALID', ENAMETOOLONG: 'LOCAL_PATH_TOO_LONG',
    EBUSY: 'LOCAL_FILE_BUSY', ETXTBSY: 'LOCAL_FILE_BUSY', EMFILE: 'LOCAL_FILES_EXHAUSTED', ENFILE: 'LOCAL_FILES_EXHAUSTED',
})[error.code ?? error.cause?.code];

function connectionCode(error) {
    const code = error.code ?? error.cause?.code;
    const text = String(error.stderr ?? '');
    if (code === 'ETIMEDOUT' || /(?:i\/o|TLS handshake|connection|operation) (?:timed out|timeout)|context deadline exceeded/iu.test(text)) return 'TIMEOUT';
    if (/proxy.*(?:407|authentication required)|(?:407|authentication required).*proxy|requested URL returned error: 407/iu.test(text)) return 'PROXY_AUTH_REQUIRED';
    if (/^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/u.test(code ?? '')
        || /x509:|certificate (?:verify failed|verification failed|has expired)|SSL certificate problem|CERT_TRUST_|SEC_E_UNTRUSTED_ROOT|tls: (?:failed|handshake failure)/iu.test(text)) return 'TLS_FAILED';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code) || /no such host|could not resolve (?:host|proxy)|temporary failure in name resolution/iu.test(text)) return 'DNS_FAILED';
    if (['ECONNRESET', 'EPIPE'].includes(code) || /unexpected EOF|connection (?:reset|aborted)|broken pipe/iu.test(text)) return 'CONNECTION_RESET';
    if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)
        || /connection refused|failed to connect|network is unreachable|no route to host/iu.test(text)) return 'CONNECTION_FAILED';
}

export function githubFailure(error) {
    const status = Number(/\(HTTP ([1-5][0-9]{2})\)/u.exec(String(error.stderr ?? ''))?.[1]) || undefined;
    let code = ({ ENOENT: 'GITHUB_CLI_REQUIRED', EACCES: 'GITHUB_CLI_ACCESS_DENIED', EPERM: 'GITHUB_CLI_ACCESS_DENIED',
        ENOBUFS: 'INPUT_SIZE_EXCEEDED' })[error.code];
    code ??= ({ 401: 'GITHUB_AUTH_INVALID', 403: 'GITHUB_ACCESS_DENIED', 404: 'GITHUB_NOT_FOUND',
        407: 'GITHUB_PROXY_AUTH_REQUIRED', 408: 'GITHUB_TIMEOUT', 409: 'GITHUB_CONFLICT',
        422: 'GITHUB_INPUT_REJECTED', 429: 'GITHUB_RATE_LIMITED' })[status];
    if (status === 403 && /(?:API|secondary) rate limit|rate limit exceeded/iu.test(String(error.stderr ?? ''))) code = 'GITHUB_RATE_LIMITED';
    if (!code && !status) {
        const connection = connectionCode(error);
        code = error.status === 4 ? 'GITHUB_AUTH_REQUIRED' : error.status === 2 ? 'CANCELLED'
            : connection ? `GITHUB_${connection}` : error.signal ? 'GITHUB_INTERRUPTED'
                : /unknown (?:shorthand )?flag:/iu.test(String(error.stderr ?? '')) ? 'GITHUB_CLI_UNSUPPORTED' : undefined;
    }
    code ??= 'GITHUB_REQUEST_FAILED';
    return Object.assign(new Error(code), { github: true, status,
        retryable: code === 'GITHUB_REQUEST_FAILED' && [500, 502, 503, 504].includes(status)
            || ['GITHUB_TIMEOUT', 'GITHUB_DNS_FAILED', 'GITHUB_CONNECTION_RESET', 'GITHUB_CONNECTION_FAILED'].includes(code),
        recoverable: !['CANCELLED', 'INPUT_SIZE_EXCEEDED', 'GITHUB_CLI_REQUIRED', 'GITHUB_CLI_ACCESS_DENIED', 'GITHUB_CLI_UNSUPPORTED',
            'GITHUB_TLS_FAILED', 'GITHUB_CONFLICT', 'GITHUB_INPUT_REJECTED'].includes(code),
        ...(Number.isInteger(error.status) && error.status >= 0 && error.status <= 255 ? { exitCode: error.status } : {}),
        ...(error.failureStep ? { failureStep: error.failureStep } : {}) });
}

export function gitFailure(error, operation) {
    const remote = ['fetch', 'push'].includes(operation);
    const text = String(error.stderr ?? '');
    const connection = connectionCode(error);
    const code = ({ ENOENT: 'TOOL_NOT_FOUND', EACCES: 'TOOL_ACCESS_DENIED', EPERM: 'TOOL_ACCESS_DENIED',
        ETIMEDOUT: remote ? 'GITHUB_TIMEOUT' : 'TOOL_TIMEOUT', ENOBUFS: 'TOOL_OUTPUT_LIMIT_EXCEEDED' })[error.code]
        ?? (/Author identity unknown|Please tell me who you are|unable to auto-detect email address/iu.test(text) ? 'GIT_IDENTITY_REQUIRED'
            : /not a git repository/iu.test(text) ? 'GIT_REPOSITORY_REQUIRED'
                : /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey\)/iu.test(text) ? 'GIT_AUTH_REQUIRED'
                    : /non-fast-forward|\[rejected\]|protected branch|GH006|GH013/iu.test(text) ? 'GIT_REMOTE_REJECTED'
                        : /repository .*not found|repository not found|requested URL returned error: (?:403|404)/iu.test(text) ? 'GIT_REMOTE_UNAVAILABLE'
                            : remote && connection ? `GITHUB_${connection}` : remote ? 'GIT_TRANSFER_FAILED' : 'TOOL_EXECUTION_FAILED');
    const retryable = remote && (['GITHUB_TIMEOUT', 'GITHUB_DNS_FAILED', 'GITHUB_CONNECTION_RESET', 'GITHUB_CONNECTION_FAILED'].includes(code)
        || code === 'GIT_TRANSFER_FAILED' && /(?:HTTP |requested URL returned error: )(?:408|500|502|503|504)/iu.test(text));
    return Object.assign(new Error(code), { tool: 'git', exitCode: error.status, github: remote, retryable,
        recoverable: remote && (retryable || code === 'GIT_TRANSFER_FAILED' || code === 'GIT_AUTH_REQUIRED' || code === 'GIT_REMOTE_UNAVAILABLE' || code === 'GITHUB_PROXY_AUTH_REQUIRED'),
        method: operation.toUpperCase(), failureStep: remote ? `git_${operation}` : 'checkingProject' });
}
