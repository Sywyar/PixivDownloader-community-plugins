import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { download } from './download.mjs';
import { API_BYTES, API_TIMEOUT } from './github.mjs';

export function proxyConfiguration(hosts) {
    if (!Array.isArray(hosts) || !hosts.length || new Set(hosts).size !== hosts.length
        || hosts.some(host => !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(host))) throw new Error('ARTIFACT_HOSTS_INVALID');
    const hostPattern = hosts.map(host => host.replaceAll('.', '[.]')).join('|');
    return `http_port 3128 ssl-bump cert=/configuration/trust/ca.pem key=/configuration/ca.key generate-host-certificates=on
sslcrtd_program /configuration/usr/lib/squid/security_file_certgen
pid_filename none
cache deny all
cache_log /dev/null
access_log none
cache_store_log none
acl CONNECT method CONNECT
acl read method GET HEAD
acl TLS port 443
acl HTTPS proto HTTPS
acl approved dstdomain ${hosts.join(' ')}
acl approvedHost req_header Host -i ^(${hostPattern})(:443)?$
acl approvedSni ssl::server_name --client-requested ${hosts.join(' ')}
acl hello at_step SslBump1
acl encrypted connections_encrypted
acl upgrade req_header Upgrade .+
acl private dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/3 ::/0
http_access deny !TLS
http_access deny !approved
http_access deny private
http_access deny upgrade
http_access deny CONNECT encrypted
http_access allow CONNECT
http_access allow read HTTPS approvedHost
http_access deny all
ssl_bump peek hello
ssl_bump bump approvedSni
ssl_bump terminate all
sslproxy_cert_error deny all
host_verify_strict on
forwarded_for delete
via off
`;
}

// 只物化 Ubuntu 签名索引所固定的 OpenSSL 工具字节，在固定镜像内执行 TLS 检查。
export async function prepareProxy(directory, policy) {
    const run = (command, args) => execFileSync(command, args, { timeout: API_TIMEOUT, maxBuffer: API_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'] });
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o755);
    const archive = path.join(directory, 'squid.deb');
    await download(policy.proxyTool.url, archive, API_BYTES, policy.proxyTool);
    run('dpkg-deb', ['--extract', archive, directory]);
    fs.writeFileSync(path.join(directory, 'squid.conf'), proxyConfiguration(policy.artifactHosts), 'utf8');
    const trust = path.join(directory, 'trust');
    fs.mkdirSync(trust);
    const key = path.join(directory, 'ca.key');
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
        '-subj', '/CN=Community build proxy', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', key, '-out', path.join(trust, 'ca.pem')]);
    fs.chmodSync(key, 0o600);
    if (process.getuid() === 0) fs.chownSync(key, 1000, 1000);
    run('keytool', ['-importcert', '-noprompt', '-alias', 'community-build-proxy', '-file', path.join(trust, 'ca.pem'),
        '-keystore', path.join(trust, 'cacerts'), '-storepass', 'changeit']);
    // 私钥仅挂给代理；构建容器只读此次公钥证书和信任库，宿主信任库保持原状。
    return trust;
}
