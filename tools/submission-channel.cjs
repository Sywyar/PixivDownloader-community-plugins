const crypto = require('node:crypto');

const CHANNEL = 'pixivdownloader-community-submission-v1';
const REPOSITORY = 'Sywyar/PixivDownloader-community-plugins';
const MAX_BYTES = 4096;
const MAX_AGE = 90 * 24 * 60 * 60;
const CLOCK_SKEW = 300;

function fail(code) { throw new Error('BOOTSTRAP_CHANNEL_' + code); }

function base64(value, maximum = MAX_BYTES) {
    if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4) fail('INVALID');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > maximum || bytes.toString('base64') !== value) fail('INVALID');
    return bytes;
}

function document(bytes, keys) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('SIZE_EXCEEDED');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID'); }
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
        || !Buffer.from(JSON.stringify(value)).equals(bytes)) fail('INVALID');
    return value;
}

function publicKey(spki) {
    const bytes = base64(spki);
    if (bytes.length !== 44 || bytes.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') fail('KEY_INVALID');
    return crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
}

function verifyEnvelope(bytes, spki, now, checkTime = true) {
    const envelope = document(bytes, ['payload', 'signature']);
    const payloadBytes = base64(envelope.payload);
    const signature = base64(envelope.signature);
    if (signature.length !== 64 || !crypto.verify(null, payloadBytes, publicKey(spki), signature)) fail('SIGNATURE_INVALID');
    const payload = document(payloadBytes, ['schemaVersion', 'channel', 'repository', 'sequence', 'runtimeCommit', 'manifestSha256', 'issuedAt', 'expiresAt']);
    if (payload.schemaVersion !== 1 || payload.channel !== CHANNEL || payload.repository !== REPOSITORY
        || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1
        || typeof payload.runtimeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(payload.runtimeCommit) || /^0+$/.test(payload.runtimeCommit)
        || typeof payload.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.manifestSha256) || /^0+$/.test(payload.manifestSha256)
        || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 1
        || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= payload.issuedAt
        || payload.expiresAt - payload.issuedAt > MAX_AGE) fail('INVALID');
    if (checkTime && (!Number.isSafeInteger(now) || payload.issuedAt > now + CLOCK_SKEW)) fail('NOT_YET_VALID');
    if (checkTime && payload.expiresAt <= now) fail('EXPIRED');
    return payload;
}

function selectChannel(bytes, previous, spki, now = Math.floor(Date.now() / 1000)) {
    const current = verifyEnvelope(bytes, spki, now);
    if (previous) {
        const prior = verifyEnvelope(previous, spki, now, false);
        if (current.sequence < prior.sequence || current.issuedAt < prior.issuedAt) fail('ROLLBACK');
        if (current.sequence === prior.sequence && !bytes.equals(previous)) fail('SEQUENCE_CONFLICT');
    }
    return current;
}

function signChannel(payload, privateKey) {
    const key = crypto.createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') fail('KEY_INVALID');
    const bytes = Buffer.from(JSON.stringify(payload));
    const envelope = Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, key).toString('base64') }));
    verifyEnvelope(envelope, crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), payload.issuedAt);
    return envelope;
}

module.exports = { CHANNEL, REPOSITORY, MAX_BYTES, MAX_AGE, CLOCK_SKEW, base64, publicKey, verifyEnvelope, selectChannel, signChannel };

if (process.argv[1] === 'verify-channel') {
    try {
        if (process.argv.length !== 5) fail('ARGUMENTS');
        const current = selectChannel(base64(process.argv[2]), process.argv[3] === '-' ? null : base64(process.argv[3]), process.argv[4]);
        process.stdout.write(JSON.stringify(current));
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
