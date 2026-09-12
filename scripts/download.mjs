import fs from 'node:fs';
import https from 'node:https';
import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { API_TIMEOUT } from './github.mjs';

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

// 每跳固定已验证的 IP，TLS 仍按原主机验证；不继承 Cookie、代理或 GitHub 凭据。
export async function download(urlText, file, maximum, expected, { lookup = dns.lookup, request = https.get } = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('DOWNLOAD_LIMIT_INVALID');
    let url = httpsUrl(urlText);
    const signal = AbortSignal.timeout(API_TIMEOUT);
    for (let redirects = 0; redirects <= 5; redirects++) {
        const hostname = url.hostname.replace(/^\[|\]$/gu, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
            : await Promise.race([lookup(hostname, { all: true }), new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(new Error('DOWNLOAD_TIMEOUT')), { once: true });
            })]);
        signal.throwIfAborted();
        if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('NONPUBLIC_ADDRESS');
        const selected = addresses[0];
        const response = await new Promise((resolve, reject) => {
            const req = request(url, { signal, agent: false, headers: { 'Accept-Encoding': 'identity' },
                lookup: (_host, options, callback) => options.all ? callback(null, [selected])
                    : callback(null, selected.address, selected.family) }, resolve);
            req.once('error', reject);
        });
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.destroy();
            if (!response.headers.location) throw new Error('DOWNLOAD_REDIRECT_INVALID');
            url = httpsUrl(new URL(response.headers.location, url).href);
            continue;
        }
        if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy();
            throw new Error('DOWNLOAD_RESPONSE_INVALID');
        }
        if (response.headers['content-length'] && Number(response.headers['content-length']) > maximum) {
            response.destroy();
            throw new Error('DOWNLOAD_SIZE_EXCEEDED');
        }
        const output = fs.openSync(file, 'wx', 0o600);
        let size = 0;
        const hash = createHash('sha256');
        try {
            for await (const chunk of response) {
                size += chunk.length;
                if (size > maximum) throw new Error('DOWNLOAD_SIZE_EXCEEDED');
                hash.update(chunk);
                for (let offset = 0; offset < chunk.length;) {
                    const count = fs.writeSync(output, chunk, offset, chunk.length - offset);
                    if (!count) throw new Error('DOWNLOAD_WRITE_FAILED');
                    offset += count;
                }
            }
            const sha256 = hash.digest('hex');
            if (expected && (size !== expected.size || sha256 !== expected.sha256)) throw new Error('DOWNLOAD_DIGEST_CHANGED');
            return { url: urlText, size, sha256, file };
        } catch (error) {
            response.destroy();
            throw error;
        } finally { fs.closeSync(output); }
    }
    throw new Error('DOWNLOAD_REDIRECT_LIMIT');
}
