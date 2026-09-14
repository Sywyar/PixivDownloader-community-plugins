import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP, BlockList } from 'node:net';
import { execFile } from 'node:child_process';

// 环境变量优先于 Windows 用户设置；绕过规则只匹配原始目标，不匹配代理地址。
export function bypassProxy(url, text = '') {
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return text.split(/[\s,]+/u).filter(Boolean).some(entry => {
        if (entry === '*') return true;
        const range = entry.split('-');
        if (range.length === 2 && range.every(item => isIP(item) === 4) && isIP(host) === 4) {
            const list = new BlockList();
            list.addRange(...range, 'ipv4');
            return list.check(host, 'ipv4');
        }
        const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(entry.toLowerCase());
        if (!match || match[2] && match[2] !== (url.port || '443')) return false;
        const name = match[1].replace(/^\[|\]$/gu, '');
        return name.startsWith('*.') ? host.endsWith(name.slice(1))
            : name.startsWith('.') ? host.endsWith(name) : host === name;
    });
}

export function proxyUrl(text) {
    try {
        if (typeof text !== 'string' || text.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(text)) throw new Error();
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error();
        decodeURIComponent(url.username); decodeURIComponent(url.password);
        return url;
    } catch { throw new Error('DOWNLOAD_PROXY_INVALID'); }
}

export async function systemProxy(url, signal) {
    // URL 通过 stdin 作为数据传入，不拼接 shell 源码，也不加载用户 profile。
    const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "
        + '$url=[uri]([Console]::In.ReadToEnd()|ConvertFrom-Json); $proxy=[Net.WebRequest]::GetSystemWebProxy(); '
        + "if ($proxy -and -not $proxy.IsBypassed($url)) { [Console]::Write($proxy.GetProxy($url).AbsoluteUri) }";
    return new Promise((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PRIVATE_KEY/iu.test(key)));
        const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true, signal, maxBuffer: 16 * 1024, env }, (error, stdout) => {
                if (error) reject(new Error(signal.aborted ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_PROXY_LOOKUP_FAILED'));
                else resolve(stdout.trim() || null);
            });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(url.href));
    });
}

export async function resolveProxy(url, signal, { env = process.env, platform = process.platform, system = systemProxy } = {}) {
    if (bypassProxy(url, env.no_proxy ?? env.NO_PROXY)) return null;
    const configured = env.https_proxy ?? env.HTTPS_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
    const selected = configured !== undefined ? configured : platform === 'win32' ? await system(url, signal) : null;
    return selected ? proxyUrl(selected) : null;
}

// CONNECT 仅携带已核对的目标 IP；源站 TLS/SNI 和 Host 仍使用原始主机。
export function tunnelAgent(proxy, selected, url, signal) {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => {
        let completed = false;
        const done = (error, socket) => { if (!completed) { completed = true; callback(error, socket); } };
        const address = selected.family === 6 ? `[${selected.address}]` : selected.address;
        const destination = `${address}:${url.port || 443}`;
        const headers = { Host: destination };
        if (proxy.username || proxy.password) headers['Proxy-Authorization'] = 'Basic '
            + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
        const request = (proxy.protocol === 'https:' ? https : http).request(new URL(proxy.origin), {
            method: 'CONNECT', path: destination, headers, agent: false, signal,
        });
        request.once('error', done);
        request.once('connect', (response, socket, head) => {
            if (response.statusCode !== 200 || head.length) {
                socket.destroy();
                done(new Error(response.statusCode === 407 ? 'DOWNLOAD_PROXY_AUTH_REQUIRED' : 'DOWNLOAD_PROXY_CONNECT_FAILED'));
                return;
            }
            const hostname = url.hostname.replace(/^\[|\]$/gu, '');
            const connection = tls.connect({ socket, servername: isIP(hostname) ? undefined : hostname,
                rejectUnauthorized: true, checkServerIdentity: (_host, certificate) => tls.checkServerIdentity(hostname, certificate) });
            const abort = () => connection.destroy(new Error('DOWNLOAD_TIMEOUT'));
            signal.addEventListener('abort', abort, { once: true });
            connection.once('close', () => signal.removeEventListener('abort', abort));
            connection.once('error', done);
            connection.once('secureConnect', () => {
                connection.removeListener('error', done);
                done(null, connection);
            });
            if (signal.aborted) abort();
        });
        request.end();
    };
    return agent;
}
