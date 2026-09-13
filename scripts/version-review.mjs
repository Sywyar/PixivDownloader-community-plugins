import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, list, prefix } from './github.mjs';
import { scanInputs } from './build-evidence.mjs';
import { pull, classify } from './platform.mjs';
import { checkPull } from './submission-pr.mjs';
import { archivedCandidates, readArchivedCandidate } from './archive-read.mjs';
import { buildInputs } from './build-reuse.mjs';

export async function versionContext(number, sdk, current, call = api, readGit) {
    const pr = pull(number, call);
    if (classify(pr, list(`${prefix}/pulls/${number}/files`, null, call)) === 'maintenance') return null;
    const checked = await checkPull(number, sdk);
    if (!['FIRST_RELEASE', 'UPDATE'].includes(checked.operation)) throw new Error('SUBMISSION_EXECUTOR_UNAVAILABLE');
    const releases = archivedCandidates(number, call).filter(release => release.tag_name.startsWith(`candidate/pr-${number}/${pr.head.sha}/`));
    if (!releases.length) throw new Error('CANDIDATE_ARCHIVE_PENDING');
    const archived = await readArchivedCandidate(sdk, releases[0], current, { call, readGit });
    const candidate = archived.candidate;
    if (candidate.submissionSha256 !== checked.submissionSha256 || !isDeepStrictEqual(candidate.submission, checked.submission)
        || !isDeepStrictEqual(candidate.owner, checked.owner) || !isDeepStrictEqual(candidate.descriptor, checked.descriptor)
        || !isDeepStrictEqual(candidate.inputs.build, buildInputs(sdk, checked))
        || !isDeepStrictEqual(candidate.inputs.scanner, scanInputs())) throw new Error('CANDIDATE_REVALIDATION_REQUIRED');
    const report = JSON.parse(fs.readFileSync(path.join(sdk.workspace, candidate.scan.riskReportRef.path), 'utf8'));
    return { checked, candidate, report, releaseId: archived.releaseId, url: archived.url };
}
