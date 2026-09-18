import fs from 'node:fs';
import path from 'node:path';
import { api, sha, prefix, policy, main } from './github.mjs';
import { root } from './sdk.mjs';
import { git } from './platform.mjs';
import { stateReader } from './submission-github.mjs';
import { readReceipt, checkResult } from './apply-result.mjs';
import { verifyPublicationProof } from './archive-proof.mjs';
import { compactReceipt, originalReceipt, hydrateReceipt, readReferencedBlob, reference, proofPath, legacyPath, verifyBytes } from './receipt-storage.mjs';

// 只生成待评审的 Git 文件；不改旧回执、签名字节或任何远端 Release。
export async function migrateReceipts(sdk, current, { call = api, readGit = git, verify = verifyPublicationProof, download } = {}) {
    const state = stateReader(sdk, current, call), writes = new Map();
    const add = (file, bytes) => {
        const before = state.raw(file) ?? writes.get(file);
        if (before && !before.equals(bytes)) throw new Error('IMMUTABLE_RESULT_CONFLICT');
        if (!before) writes.set(file, bytes);
    };
    for (const file of state.tree.keys()) {
        if (!/^generated\/receipts\/[a-f0-9]{64}\.json$/u.test(file)) continue;
        const pointer = JSON.parse(state.raw(file));
        if (pointer.schemaVersion !== 1 || state.tree.has(legacyPath(pointer.sha256))) continue;
        let bundle;
        const options = { call, readGit, download, verify: (manifest, attestation, ...args) => {
            const certificate = verify(manifest, attestation, ...args);
            bundle = fs.readFileSync(attestation);
            return certificate;
        } };
        const receipt = await readReceipt(sdk, pointer, current, options);
        const completion = await checkResult(receipt.prNumber, sdk, current, { ...options, merged: true });
        if (JSON.stringify(completion.pointer) !== JSON.stringify(pointer)) throw new Error('APPLY_RECEIPT_CHANGED');
        const compact = compactReceipt(receipt);
        // 迁移只引用原 Git 历史已持有的正文；证明重建后仍是签名覆盖的精确字节。
        const reconstructed = hydrateReceipt(compact, ref => readReferencedBlob(ref, call));
        verifyBytes(originalReceipt(reconstructed), pointer);
        const attestation = reference(bundle);
        add(proofPath(attestation.sha256), bundle);
        add(legacyPath(pointer.sha256), Buffer.from(JSON.stringify({ receipt: compact, attestation }) + '\n', 'utf8'));
    }
    if (sha(call(`${prefix}/branches/${policy.defaultBranch}`).commit.sha) !== current) throw new Error('APPLY_BASE_CHANGED');
    return writes;
}

main(import.meta.url, async () => {
    if (process.argv.length !== 2) throw new Error('MIGRATION_ARGUMENTS_INVALID');
    const current = sha(git(['rev-parse', `origin/${policy.defaultBranch}`]));
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const sdk = { workspace: fs.mkdtempSync(path.join(root, 'target', 'receipt-migration-')) };
    try {
        const writes = await migrateReceipts(sdk, current);
        // 全部远端证明和原父链检查成功后，才写入当前工作区。
        for (const [file, bytes] of writes) {
            const target = path.join(root, file);
            if (fs.existsSync(target) && !fs.readFileSync(target).equals(bytes)) throw new Error('IMMUTABLE_RESULT_CONFLICT');
        }
        for (const [file, bytes] of writes) {
            const target = path.join(root, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
        }
        console.log(JSON.stringify({ files: [...writes.keys()] }));
    } finally { fs.rmSync(sdk.workspace, { recursive: true, force: true }); }
});
