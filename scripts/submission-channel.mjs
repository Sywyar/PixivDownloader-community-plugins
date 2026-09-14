import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import channel from '../tools/submission-channel.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const launcher = path.join(root, 'tools/submit.ps1');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (directory, ...args) => execFileSync('git', ['--no-optional-locks', '-C', directory, ...args],
    { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function embeddedVerifier(source = fs.readFileSync(launcher, 'utf8')) {
    const match = source.match(/\$ChannelVerifier = @'\r?\n([\s\S]*?)\r?\n'@/u);
    if (!match) throw new Error('CHANNEL_VERIFIER_MISSING');
    return match[1].replaceAll('\r\n', '\n');
}

export function pinnedKey(source = fs.readFileSync(launcher, 'utf8')) {
    const key = source.match(/\$ChannelPublicKey = '([^']+)'/u)?.[1];
    channel.publicKey(key);
    return key;
}

export function runtimeManifest(directory, commit, base = 'refs/remotes/origin/master') {
    if (!/^[0-9a-f]{40}$/u.test(commit) || /^0+$/u.test(commit)) throw new Error('CHANNEL_COMMIT_INVALID');
    git(directory, 'merge-base', '--is-ancestor', commit, base);
    const blob = name => {
        const entry = git(directory, 'ls-tree', commit, '--', name).toString('utf8');
        if (!/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry) || entry.trimEnd().split('\t')[1] !== name) throw new Error('CHANNEL_RUNTIME_FILE_INVALID');
        return git(directory, 'show', commit + ':' + name);
    };
    const bytes = blob('tools/submission-files.json');
    if (bytes.length > 65536) throw new Error('CHANNEL_MANIFEST_INVALID');
    const manifest = JSON.parse(bytes);
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 256) throw new Error('CHANNEL_MANIFEST_INVALID');
    const seen = new Set();
    let total = 0;
    for (const file of manifest.files) {
        if (!file || typeof file.path !== 'string' || !/^(scripts|tools|schemas)\/[A-Za-z0-9._/-]+$/u.test(file.path)
            || file.path.split('/').some(part => !part || part === '.' || part === '..')
            || seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 1
            || !/^[a-f0-9]{64}$/u.test(file.sha256) || (total += file.size) > 64 * 1024 * 1024) throw new Error('CHANNEL_MANIFEST_INVALID');
        seen.add(file.path.toLowerCase());
        const content = blob(file.path);
        if (content.length !== file.size || digest(content) !== file.sha256) throw new Error('CHANNEL_RUNTIME_CHANGED');
    }
    if (!seen.has('scripts/submit.mjs')) throw new Error('CHANNEL_ENTRY_MISSING');
    return digest(bytes);
}

export function issueChannel({ directory = root, commit, previous, key, privateKey, now = Math.floor(Date.now() / 1000), base }) {
    const prior = previous ? channel.verifyEnvelope(previous, key, now, false) : null;
    const manifestSha256 = runtimeManifest(directory, commit, base);
    const bytes = channel.signChannel({ schemaVersion: 1, channel: channel.CHANNEL, repository: channel.REPOSITORY,
        sequence: prior ? prior.sequence + 1 : 1, runtimeCommit: commit, manifestSha256,
        issuedAt: now, expiresAt: now + channel.MAX_AGE }, privateKey);
    channel.selectChannel(bytes, previous, key, now);
    return bytes;
}

async function main() {
    const [command, commit, output] = process.argv.slice(2);
    if (command === 'embed' || command === 'check') {
        if (process.argv.length !== 3) throw new Error('CHANNEL_ARGUMENTS');
        const source = fs.readFileSync(launcher, 'utf8');
        const verifier = fs.readFileSync(path.join(root, 'tools/submission-channel.cjs'), 'utf8').trimEnd();
        if (command === 'embed') fs.writeFileSync(launcher, source.replace(embeddedVerifier(source), () => verifier), 'utf8');
        else if (embeddedVerifier(source) !== verifier) throw new Error('CHANNEL_VERIFIER_CHANGED');
        return;
    }
    if (command !== 'issue' || process.argv.length !== 5 || !output) throw new Error('CHANNEL_ARGUMENTS');
    if (process.env.GITHUB_ACTIONS === 'true' && (process.env.GITHUB_REPOSITORY !== channel.REPOSITORY
        || process.env.GITHUB_REPOSITORY_ID !== '1347624983' || process.env.GITHUB_REPOSITORY_OWNER_ID !== '83223374'
        || process.env.GITHUB_REF !== 'refs/heads/master' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) throw new Error('CHANNEL_WORKFLOW_INVALID');
    const encodedKey = process.env.COMMUNITY_TOOL_CHANNEL_PRIVATE_KEY_BASE64;
    delete process.env.COMMUNITY_TOOL_CHANNEL_PRIVATE_KEY_BASE64;
    const privateBytes = channel.base64(encodedKey, 16384);
    try {
        const previousRef = 'refs/remotes/origin/master:tools/submission-channel.json';
        const previousEntry = git(root, 'ls-tree', 'refs/remotes/origin/master', '--', 'tools/submission-channel.json').toString('utf8');
        if (previousEntry && !/^100644 blob [0-9a-f]{40}\ttools\/submission-channel\.json\r?\n$/u.test(previousEntry)) throw new Error('CHANNEL_PREVIOUS_INVALID');
        if (previousEntry && Number(git(root, 'cat-file', '-s', previousRef).toString('utf8')) > channel.MAX_BYTES) throw new Error('CHANNEL_PREVIOUS_TOO_LARGE');
        const previous = previousEntry ? git(root, 'show', previousRef) : null;
        const bytes = issueChannel({ commit, previous, key: pinnedKey(), privateKey: privateBytes });
        fs.writeFileSync(output, bytes, { flag: 'wx' });
        const payload = channel.verifyEnvelope(bytes, pinnedKey(), Math.floor(Date.now() / 1000));
        console.log(JSON.stringify({ sequence: payload.sequence, runtimeCommit: commit, manifestSha256: payload.manifestSha256, expiresAt: payload.expiresAt }));
    } finally { privateBytes.fill(0); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
