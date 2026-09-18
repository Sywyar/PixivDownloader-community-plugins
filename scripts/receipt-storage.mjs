import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { API_BYTES, API_TIMEOUT, policy, sha } from './github.mjs';
import { hash, root } from './sdk.mjs';
import { readBlob } from './submission-github.mjs';

export const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const digest = value => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('APPLY_RECEIPT_INVALID'); return value; };
export const proofPath = value => `generated/proofs/${digest(value)}.json`;
export const legacyPath = value => `generated/legacy-receipts/${digest(value)}.json`;
export const reference = bytes => ({ size: bytes.length, sha256: hash(bytes), blob: blobSha(bytes) });

export function verifyBytes(bytes, ref) {
    if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > API_BYTES || bytes.length !== ref.size
        || hash(bytes) !== digest(ref.sha256) || ref.blob !== undefined && blobSha(bytes) !== sha(ref.blob)) throw new Error('APPLY_RECEIPT_CHANGED');
    return bytes;
}

// 正文只存一次；回执引用已有 Git blob，Base64 仅在调用旧内存接口时生成。
export function hydrateReceipt(receipt, read) {
    let total = 0;
    if (![2, 3].includes(receipt.schemaVersion) || !Array.isArray(receipt.files)) throw new Error('APPLY_RECEIPT_INVALID');
    return { ...receipt, files: receipt.files.map(file => {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || (total += file.size) > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
        const bytes = file.bytes === undefined ? read(file) : Buffer.from(file.bytes, 'base64');
        verifyBytes(bytes, file);
        if (file.bytes !== undefined && bytes.toString('base64') !== file.bytes) throw new Error('APPLY_RECEIPT_CHANGED');
        return { ...file, bytes: bytes.toString('base64') };
    }) };
}

export const compactReceipt = receipt => ({ ...receipt, files: receipt.files.map(({ bytes, ...file }) => ({
    ...file, blob: file.blob ?? blobSha(Buffer.from(bytes, 'base64')),
})) });

export function originalReceipt(receipt) {
    const value = receipt.schemaVersion === 2 ? { ...receipt, files: receipt.files.map(({ blob, ...file }) => file) } : compactReceipt(receipt);
    return Buffer.from(JSON.stringify(value) + '\n', 'utf8');
}

export function readReferencedBlob(ref, call, name = policy.repository, directory = root) {
    sha(ref.blob);
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > API_BYTES) throw new Error('APPLY_RECEIPT_BUDGET');
    // 合并历史已由 checkout 获取，直接读取原始 Git 对象，避免每份回执逐项重复下载。
    if (fs.existsSync(path.join(directory, '.git'))) {
        const result = execFileSync('git', ['-C', directory, 'cat-file', '--batch'], { input: ref.blob + '\n',
            windowsHide: true, timeout: API_TIMEOUT, maxBuffer: API_BYTES + 256, stdio: ['pipe', 'pipe', 'pipe'] });
        const newline = result.indexOf(10), header = result.subarray(0, newline).toString('ascii');
        if (header !== `${ref.blob} missing`) {
            if (newline < 0 || header !== `${ref.blob} blob ${ref.size}` || result.at(-1) !== 10) throw new Error('APPLY_RECEIPT_CHANGED');
            return verifyBytes(result.subarray(newline + 1, -1), ref);
        }
    }
    return verifyBytes(readBlob(name, { type: 'blob', mode: '100644', sha: sha(ref.blob), size: ref.size }, call), ref);
}

export function receiptProofs(pointer) {
    if (pointer.schemaVersion !== 2) return [];
    return [pointer.manifest, pointer.attestation].map(ref => [proofPath(ref.sha256), ref]);
}

export function saveReceiptFiles(receipt, directory) {
    fs.mkdirSync(directory, { recursive: true });
    for (const file of receipt.files) {
        const bytes = verifyBytes(Buffer.from(file.bytes, 'base64'), file), target = path.join(directory, sha(file.blob));
        if (fs.existsSync(target)) verifyBytes(fs.readFileSync(target), file);
        else fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
}

export function readReceiptFiles(receipt, directory) {
    return hydrateReceipt(receipt, ref => {
        const file = path.join(directory, sha(ref.blob));
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.size) throw new Error('APPLY_RECEIPT_CHANGED');
        return fs.readFileSync(file);
    });
}
