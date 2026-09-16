import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { api, list, prefix } from './github.mjs';
import { scanInputs } from './build-evidence.mjs';
import { pull, classify } from './platform.mjs';
import { checkPull } from './submission-pr.mjs';
import { archivedCandidates, readArchivedCandidate } from './archive-read.mjs';
import { buildInputs } from './build-reuse.mjs';
import { checkResult } from './apply-result.mjs';
import { id } from './github.mjs';

export async function versionContext(number, sdk, current, call = api, readGit, { appliedBase, checkCall, fetch } = {}) {
    const pr = pull(number, call);
    const operation = classify(pr, list(`${prefix}/pulls/${number}/files`, null, call));
    if (operation === 'maintenance') return null;
    if (operation === 'apply-result') {
        const result = await checkResult(number, sdk, current, { call, readGit });
        return { checked: { operation: 'APPLY_RESULT', requestSha256: result.pointer.sha256,
            pr: { head: pr.head.sha, base: pr.base.sha, user: { id: id(pr.user.id), type: 'User' } } }, ...result };
    }
    const checked = await checkPull(number, sdk, checkCall, fetch, { appliedBase });
    if (!['FIRST_RELEASE', 'UPDATE'].includes(checked.operation)) return { checked };
    const releases = archivedCandidates(number, call).filter(release => release.tag_name.startsWith(`candidate/pr-${number}/${pr.head.sha}/`));
    if (!releases.length) throw new Error('CANDIDATE_ARCHIVE_PENDING');
    const archived = await readArchivedCandidate(sdk, releases[0], current, { call, readGit });
    const candidate = archived.candidate;
    if (candidate.submissionSha256 !== checked.submissionSha256 || !isDeepStrictEqual(candidate.submission, checked.submission)
        || !isDeepStrictEqual(candidate.owner, checked.owner) || !isDeepStrictEqual(candidate.descriptor, checked.descriptor)
        || !isDeepStrictEqual(candidate.inputs.build, buildInputs(sdk, checked))
        || !isDeepStrictEqual(candidate.inputs.scanner, scanInputs())) throw new Error('CANDIDATE_REVALIDATION_REQUIRED');
    const report = JSON.parse(fs.readFileSync(path.join(sdk.workspace, candidate.scan.riskReportRef.path), 'utf8'));
    return { checked, candidate, report, directory: archived.directory, releaseId: archived.releaseId, url: archived.url };
}
