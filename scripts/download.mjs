import fs from 'node:fs';
import https from 'node:https';
import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { API_TIMEOUT } from './github.mjs';
import { resolveProxy, tunnelAgent } from './download-proxy.mjs';
import { observe, currentStep } from './submission-progress.mjs';
import { retryRequest } from './submission-retry.mjs';
import { localFailureCode } from './submission-errors.mjs';

const excluded = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
    excluded.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
    excluded.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicAddress(address) {
    const family = isIP(address);
    return family === 4 ? !excluded.check(address, 'ipv4')
        : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

export function httpsUrl(text) {
    if (typeof text !== 'string' || text.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(text)) throw new Error('HTTPS_URL_INVALID');
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('HTTPS_URL_INVALID');
    return url;
}

// 每跳固定已验证的 IP，TLS 仍按原主机验证；不继承 Cookie 或 GitHub 凭据。
export async function download(urlText, file, maximum, expected, options) {
    let totalAttempts = 0;
    for (let round = 1; ; round++) {
        try { return await downloadRound(urlText, file, maximum, expected, options); }
        catch (error) {
            if (!error.download || !error.retryable) throw error;
            error.failureStep ??= currentStep() ?? 'downloading';
            error.totalAttempts = totalAttempts += error.attempts ?? 0;
            if (!retryRequest(error, round)) throw new Error('WIZARD_SAVE');
        }
    }
}

async function downloadRound(urlText, file, maximum, expected, {
    lookup = dns.lookup, request = https.get, proxyForUrl = resolveProxy, timeout = API_TIMEOUT,
    now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }),
} = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('DOWNLOAD_LIMIT_INVALID');
    const initialUrl = httpsUrl(urlText);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const { signal } = controller;
    const deadline = now() + timeout;
    let stage = 'DNS';
    let attempts = 0;
    const checkTime = () => { if (signal.aborted || now() >= deadline) throw new Error('DOWNLOAD_TIMEOUT'); };
    const classify = error => {
        const native = error.code ?? error.cause?.code;
        let code = stage === 'FILE' && localFailureCode(error) ? localFailureCode(error)
            : ['ETIMEDOUT', 'ABORT_ERR'].includes(native) ? 'DOWNLOAD_TIMEOUT'
            : ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_SSL_UNEXPECTED_EOF_WHILE_READING'].includes(native) ? 'DOWNLOAD_CONNECTION_RESET'
                : ['ENOTFOUND', 'EAI_AGAIN'].includes(native) ? 'DOWNLOAD_DNS_FAILED'
                    : ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(native) ? 'DOWNLOAD_CONNECTION_FAILED'
                        : /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/u.test(native ?? '') ? 'DOWNLOAD_TLS_FAILED'
                            : /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message
                                : signal.aborted || now() >= deadline ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_FAILED';
        if ((signal.aborted || now() >= deadline)
            && ['DOWNLOAD_CONNECTION_RESET', 'DOWNLOAD_DNS_FAILED', 'DOWNLOAD_CONNECTION_FAILED'].includes(code)) code = 'DOWNLOAD_TIMEOUT';
        const retryable = stage !== 'FILE' && (['DOWNLOAD_TIMEOUT', 'DOWNLOAD_CONNECTION_RESET', 'DOWNLOAD_DNS_FAILED', 'DOWNLOAD_CONNECTION_FAILED'].includes(code)
            || [408, 500, 502, 503, 504].includes(error.status));
        return Object.assign(new Error(code), { download: true, retryable, downloadStage: stage, attempts,
            ...(error.status ? { status: error.status } : {}) });
    };
    const attempt = async () => {
        let url = initialUrl;
        let agent, response, output;
        let created = false, complete = false;
        try {
            checkTime();
            attempts++;
            for (let redirects = 0; redirects <= 5; redirects++) {
                checkTime();
                stage = 'DNS';
                const hostname = url.hostname.replace(/^\[|\]$/gu, '');
                let abort;
                let addresses;
                try {
                    addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
                        : await Promise.race([lookup(hostname, { all: true }), new Promise((_, reject) => {
                            abort = () => reject(new Error('DOWNLOAD_TIMEOUT'));
                            signal.addEventListener('abort', abort, { once: true });
                        })]);
                } finally { if (abort) signal.removeEventListener('abort', abort); }
                checkTime();
                if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('NONPUBLIC_ADDRESS');
                const selected = addresses[0];
                stage = 'PROXY';
                const proxy = await proxyForUrl(url, signal);
                checkTime();
                agent = proxy ? tunnelAgent(proxy, selected, url, signal, value => { stage = value; }) : null;
                stage = proxy ? 'PROXY_CONNECT' : 'CONNECT';
                response = await new Promise((resolve, reject) => {
                    const req = request(url, { signal, agent: agent ?? false, headers: { 'Accept-Encoding': 'identity' },
                        lookup: (_host, options, callback) => options.all ? callback(null, [selected])
                            : callback(null, selected.address, selected.family) }, resolve);
                    if (!proxy) req.once('socket', socket => {
                        socket.once('connect', () => { stage = 'TLS'; });
                        socket.once('secureConnect', () => { stage = 'HEADERS'; });
                    });
                    req.once('error', reject);
                });
                checkTime();
                stage = 'HEADERS';
                if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                    response.destroy();
                    agent?.destroy();
                    if (!response.headers.location) throw new Error('DOWNLOAD_REDIRECT_INVALID');
                    url = httpsUrl(new URL(response.headers.location, url).href);
                    continue;
                }
                if (response.statusCode !== 200) throw Object.assign(new Error('DOWNLOAD_RESPONSE_INVALID'), { status: response.statusCode });
                if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('DOWNLOAD_RESPONSE_INVALID');
                if (response.headers['content-length'] && Number(response.headers['content-length']) > maximum) throw new Error('DOWNLOAD_SIZE_EXCEEDED');
                stage = 'FILE';
                output = fs.openSync(file, 'wx', 0o600);
                created = true;
                let size = 0;
                const hash = createHash('sha256');
                stage = 'BODY';
                for await (const chunk of response) {
                    checkTime();
                    size += chunk.length;
                    if (size > maximum) throw new Error('DOWNLOAD_SIZE_EXCEEDED');
                    hash.update(chunk);
                    stage = 'FILE';
                    for (let offset = 0; offset < chunk.length;) {
                        const count = fs.writeSync(output, chunk, offset, chunk.length - offset);
                        if (!count) throw new Error('DOWNLOAD_WRITE_FAILED');
                        offset += count;
                    }
                    stage = 'BODY';
                }
                checkTime();
                const sha256 = hash.digest('hex');
                if (expected && (size !== expected.size || sha256 !== expected.sha256)) throw new Error('DOWNLOAD_DIGEST_CHANGED');
                complete = true;
                return { url: urlText, size, sha256, file };
            }
            throw new Error('DOWNLOAD_REDIRECT_LIMIT');
        } finally {
            response?.destroy();
            agent?.destroy();
            try {
                if (output !== undefined) fs.closeSync(output);
                // 仅删除本次以 wx 创建的半文件，不覆盖或删除原有文件。
                if (created && !complete) fs.unlinkSync(file);
            } catch (error) { stage = 'FILE'; throw error; }
        }
    };
    try {
        for (;;) {
            try {
                return await attempt();
            } catch (error) {
                if (error.message === 'CANCELLED') throw error;
                const failure = classify(error);
                const backoff = attempts * 1000;
                if (!failure.retryable || attempts >= 3 || signal.aborted || now() + backoff >= deadline) throw failure;
                try { await observe('retryingDownload', `${attempts + 1}/3`, () => wait(backoff, signal)); }
                catch (error) { if (error.message === 'CANCELLED') throw error; throw classify(error); }
            }
        }
    } finally { clearTimeout(timer); }
}
