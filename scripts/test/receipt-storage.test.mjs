import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compactReceipt, hydrateReceipt, originalReceipt, reference, proofPath, legacyPath, saveReceiptFiles, readReceiptFiles, readReferencedBlob } from '../receipt-storage.mjs';
import { readReceipt } from '../apply-result.mjs';
import { policy, prefix } from '../github.mjs';

test('正文按 Git 对象复用，历史回执无损重建且拒绝替换', async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-storage-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const data = Buffer.from('审核证据'.repeat(12000));
    const legacy = { schemaVersion: 2, repositoryId: policy.repositoryId, requestId: 'a'.repeat(64), baseSha: 'b'.repeat(40),
        files: ['records/' + 'c'.repeat(64) + '.json', 'reviews/evidence/' + 'c'.repeat(64) + '.json'].map(path => ({ path,
            size: data.length, sha256: reference(data).sha256, before: null, bytes: data.toString('base64') })) };
    const original = Buffer.from(JSON.stringify(legacy) + '\n');
    const compact = compactReceipt(legacy), bundle = Buffer.from('{"proof":"fixture"}');
    const bundleRef = reference(bundle), projection = Buffer.from(JSON.stringify({ receipt: compact, attestation: bundleRef }));
    assert(projection.length < data.length);
    assert(compact.files.every(file => file.bytes === undefined));
    assert.deepEqual(originalReceipt(hydrateReceipt(compact, () => data)), original);
    const pointer = { schemaVersion: 1, releaseId: '501', size: original.length, sha256: reference(original).sha256 };
    const objects = new Map([data, projection, bundle].map(bytes => [reference(bytes).blob, bytes]));
    let verified = 0;
    const options = { call: endpoint => {
        assert(endpoint.startsWith(prefix + '/git/blobs/'), '迁移后不访问 Release');
        const blob = endpoint.split('/').at(-1), bytes = objects.get(blob);
        return { sha: blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
    }, readGit: args => {
        assert.equal(args.at(-1), legacyPath(pointer.sha256));
        return reference(projection).blob + ' ' + projection.length;
    }, verify: (file, proof) => {
        assert.deepEqual(fs.readFileSync(file), original); assert.deepEqual(fs.readFileSync(proof), bundle);
        verified++; return { sourceRepositoryDigest: legacy.baseSha };
    } };
    assert.deepEqual(await readReceipt({ workspace }, pointer, legacy.baseSha, options), legacy);
    assert.equal(verified, 1);
    objects.set(reference(data).blob, Buffer.from('replacement'));
    await assert.rejects(readReceipt({ workspace }, pointer, legacy.baseSha, options), /GITHUB_BLOB_CHANGED|APPLY_RECEIPT_CHANGED/);
    assert.equal(verified, 1);
});

test('跨作业交接只保留一份正文，缺失或篡改在提交前拒绝', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-files-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.from('shared output');
    const receipt = { schemaVersion: 3, files: ['first', 'second'].map(path => ({ path, ...reference(bytes), bytes: bytes.toString('base64') })) };
    saveReceiptFiles(receipt, directory);
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.deepEqual(readReceiptFiles(compactReceipt(receipt), directory), receipt);
    fs.writeFileSync(path.join(directory, reference(bytes).blob), 'wrong output');
    assert.throws(() => readReceiptFiles(compactReceipt(receipt), directory), /APPLY_RECEIPT_CHANGED/);
    assert.throws(() => proofPath('../escape'), /APPLY_RECEIPT_INVALID/);
});

test('已有 Git 对象直接验原始字节，二进制与末尾换行不经文本转换', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-git-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (args, input) => execFileSync('git', ['-C', directory, ...args], { input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    git(['init', '-q']);
    const bytes = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('审核字节\n\n')]), ref = reference(bytes);
    assert.equal(git(['hash-object', '-w', '--stdin'], bytes).toString('ascii').trim(), ref.blob);
    const call = () => assert.fail('本地存在的不可变 Git 对象不再下载');
    assert.deepEqual(readReferencedBlob(ref, call, policy.repository, directory), bytes);
    assert.throws(() => readReferencedBlob({ ...ref, sha256: 'f'.repeat(64) }, call, policy.repository, directory), /APPLY_RECEIPT_CHANGED/);
});
