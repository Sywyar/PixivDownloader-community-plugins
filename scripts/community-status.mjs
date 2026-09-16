import fs from 'node:fs';
import { list, prefix, main } from './github.mjs';
import { event, pull, classify } from './platform.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { preparePublication, prepareResult, storeResult, waitingProjection, inputsFrom } from './community-publication.mjs';
import { statusExecution, statusInputs } from './status-execution.mjs';
import { mergeStatus } from './status-merge.mjs';
import { notify } from './community-gate.mjs';

const output = value => {
    for (const [key, item] of Object.entries(value)) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${item}\n`, 'utf8');
};

main(import.meta.url, async () => {
    const mode = process.argv[2];
    if (!['preflight', 'prepare', 'store', 'merge', 'notify'].includes(mode) || process.argv.length !== 3) throw new Error('STATUS_COMMAND_INVALID');
    const privateValue = process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    delete process.env.COMMUNITY_RELEASE_PRIVATE_KEY_BASE64;
    if (privateValue && (mode !== 'prepare' || privateValue.length > 21848)) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
    const privateBytes = Buffer.from(privateValue ?? '', 'base64');
    try {
        const context = statusExecution();
        if (mode === 'notify') { notify(JSON.parse(process.env.COMMUNITY_PROJECTIONS)); return; }
        const inputs = mode === 'preflight' ? statusInputs(context, event())
            : inputsFrom({ inputs: JSON.parse(process.env.COMMUNITY_STATUS_INPUTS) });
        // 后续 job/step 使用预检冻结的 head，不能随投稿者更新偷偷改处理目标。
        const pr = pull(inputs.prNumber);
        if (mode === 'preflight') {
            if (pr.state !== 'open' || pr.merged || pr.draft) { output({ ready: 'false', projections: '[]' }); return; }
            const files = list(`${prefix}/pulls/${pr.number}/files`, null);
            const type = classify(pr, files);
            if (type !== 'status' && !(type === 'review-completed' && files.some(file => file.filename.startsWith('version-status-requests/')))) {
                output({ ready: 'false', projections: '[]' }); return;
            }
        }
        const sdk = prepareSubmission();
        if (mode === 'merge') {
            const result = await mergeStatus(context, sdk, inputs.prNumber, process.env.COMMUNITY_STATUS_HEAD);
            output({ merged: String(result.merged === true), projections: JSON.stringify(result.pending ? [waitingProjection(result.pr, result.pending)] : []) });
            return;
        }
        if (mode === 'store') {
            const result = await storeResult(context, process.env.COMMUNITY_PUBLICATION_FILE, process.env.COMMUNITY_ATTESTATION_BUNDLE, sdk, inputs);
            output({ projections: JSON.stringify(result.pending ? [waitingProjection(result.pr, result.pending)] : []), head: result.head ?? '' });
            return;
        }
        const prepared = await preparePublication(context, inputs, sdk);
        if (prepared.pending) { output({ ready: 'false', projections: JSON.stringify([waitingProjection(prepared.selected.pr, prepared.pending)]) }); return; }
        if (mode === 'preflight') { output({ ready: 'true', inputs: JSON.stringify(inputs), projections: '[]' }); return; }
        if (prepared.replayed) { output({ head: prepared.selected.pr.head.sha }); return; }
        if (process.env.HAS_REVIEW_BRANCH_TOKEN !== 'true') {
            output({ projections: JSON.stringify([waitingProjection(prepared.selected.pr, 'STATUS_MERGE_CREDENTIAL_REQUIRED')]) }); return;
        }
        if (!privateBytes.length || privateBytes.length > 16384 || privateBytes.toString('base64') !== privateValue) throw new Error('COMMUNITY_SIGNING_KEY_INVALID');
        const communityKey = { keyId: process.env.COMMUNITY_RELEASE_KEY_ID, algorithm: 'Ed25519',
            publicKeySpkiBase64: process.env.COMMUNITY_RELEASE_PUBLIC_KEY_BASE64, state: 'ACTIVE',
            publisher: 'PixivDownloader Community', trustLabel: 'Community source review', official: false };
        output({ manifest: (await prepareResult(context, inputs, sdk, prepared, { privateBytes, communityKey })).file });
    } finally { privateBytes.fill(0); }
});
