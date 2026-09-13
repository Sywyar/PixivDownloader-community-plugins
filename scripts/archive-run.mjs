import path from 'node:path';
import fs from 'node:fs';
import { api, id, list, prefix, main, API_BYTES } from './github.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { execution, event } from './platform.mjs';
import { archivePath, buildPath } from './candidate.mjs';
import { downloadCandidate, unpackCandidate } from './candidate-transfer.mjs';
import { archiveCandidate } from './archive.mjs';
import { storeArchiveProof } from './archive-proof.mjs';

main(import.meta.url, async () => {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_run') throw new Error('ARCHIVE_WORKFLOW_REQUIRED');
    const context = execution(archivePath);
    if (process.argv[2] === 'attestation' && process.argv.length === 3) {
        await storeArchiveProof(process.env.COMMUNITY_RELEASE_ID, process.env.COMMUNITY_CANDIDATE_FILE,
            process.env.COMMUNITY_ATTESTATION_BUNDLE, context.current);
        return;
    }
    if (process.argv.length !== 2) throw new Error('ARCHIVE_ARGUMENTS');
    const trigger = event().workflow_run;
    if (trigger.path !== buildPath || !['pull_request_target', 'workflow_dispatch'].includes(trigger.event)
        || trigger.conclusion !== 'success') throw new Error('ARCHIVE_TRIGGER_INVALID');
    const runId = id(trigger.id), attempt = id(trigger.run_attempt);
    const artifacts = list(`${prefix}/actions/runs/${runId}/artifacts`, 'artifacts').filter(artifact => artifact.name.startsWith(`community-build-${runId}-${attempt}-`));
    if (!artifacts.length) return;
    if (artifacts.length !== 1) throw new Error('BUILD_ARTIFACT_AMBIGUOUS');
    const artifact = artifacts[0];
    if (artifact.expired || id(artifact.workflow_run.id) !== runId
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)) throw new Error('BUILD_ARTIFACT_INVALID');
    const sdk = prepareSubmission();
    const maximum = 2 * sdk.invoke({ command: 'limits' }).maxArchiveBytes + 2 * API_BYTES;
    if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes > maximum) throw new Error('BUILD_ARTIFACT_SIZE');
    const file = path.join(sdk.workspace, 'handoff.zip');
    await downloadCandidate(`${prefix}/actions/artifacts/${id(artifact.id)}/zip`, file, maximum,
        { size: artifact.size_in_bytes, sha256: artifact.digest.slice(7) });
    const { candidate, directory } = unpackCandidate(sdk, file);
    if (candidate.runId !== runId || candidate.runAttempt !== Number(attempt)
        || artifact.name !== `community-build-${runId}-${attempt}-${candidate.inputSha256}`) throw new Error('BUILD_ARTIFACT_CHANGED');
    const archived = await archiveCandidate(sdk, candidate, directory, context.current, { call: api });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${archived.releaseId}\nmanifest=${path.join(directory, 'candidate.json')}\n`, 'utf8');
    console.log(JSON.stringify(archived));
});
