import fs from 'node:fs';
import path from 'node:path';
import { API_BYTES, id, sha, policy } from './github.mjs';
import { hash } from './sdk.mjs';
import { fileSnapshot } from './build-files.mjs';

export const buildPath = '.github/workflows/submission-check.yml';
export const archivePath = '.github/workflows/community-archive.yml';
export const candidateName = (number, head, digest) => `candidate/pr-${id(number)}/${sha(head)}/${digest}`;
// 草稿槽位按发布身份复用；PR、head 和构建摘要继续保留在签名清单中。
export function candidateSlot({ owner, submission }) {
    if (!owner || !['User', 'Organization'].includes(owner.accountType)
        || ![owner.publisherId, submission?.pluginId, submission?.version].every(value => typeof value === 'string' && value.length > 0)) {
        throw new Error('CANDIDATE_IDENTITY_INVALID');
    }
    return `candidate/${hash(Buffer.from(JSON.stringify([id(owner.accountId), owner.accountType,
        owner.publisherId, submission.pluginId, submission.version])))}`;
}
const digest = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('CANDIDATE_DIGEST_INVALID');
    return value;
};

export function candidateIdentity(value) {
    if (value.schemaVersion !== 1 || value.state !== 'PENDING_REVIEW'
        || value.repositoryId !== policy.repositoryId || value.repositoryOwnerId !== policy.repositoryOwnerId
        || value.workflowPath !== buildPath || !Number.isSafeInteger(value.runAttempt) || value.runAttempt < 1) {
        throw new Error('CANDIDATE_IDENTITY_INVALID');
    }
    id(value.runId); id(value.pr.number); id(value.pr.headId); id(value.sourceRepositoryId); sha(value.workflowSha); sha(value.pr.base);
    if (value.inputSha256 !== hash(Buffer.from(JSON.stringify(value.inputs)))) throw new Error('CANDIDATE_INPUT_CHANGED');
    return candidateName(value.pr.number, value.pr.head, digest(value.inputSha256));
}

export function checkFiles(files, maximum) {
    if (!Array.isArray(files) || new Set(files.map(file => file.path)).size !== files.length) throw new Error('CANDIDATE_FILES_INVALID');
    let total = 0;
    for (const file of files) {
        if (!/^(?:plugin\.(?:jar|zip)|source\.zip|review-evidence\.zip|reviews\/evidence\/[a-f0-9]{64}\.json)$/u.test(file.path)
            || !Number.isSafeInteger(file.size) || file.size < 0 || (total += file.size) > maximum) throw new Error('CANDIDATE_FILES_INVALID');
        digest(file.sha256);
    }
}

export function verifyFiles(directory, files, maximum) {
    checkFiles(files, maximum);
    for (const file of files) {
        const absolute = path.join(directory, file.path);
        if (!fs.lstatSync(absolute).isFile() || fs.statSync(absolute).size !== file.size
            || hash(fs.readFileSync(absolute)) !== file.sha256) throw new Error('CANDIDATE_FILE_CHANGED');
    }
}

// 包与源码直接留存；报告按已有内容寻址路径装入一个 ZIP，避免每条调用单独建立 Release asset。
export async function writeCandidate(sdk, checked, build, scan, inputs, execution, directory) {
    const evidenceFiles = await fileSnapshot(path.join(sdk.workspace, 'reviews'), API_BYTES);
    const evidenceRefs = evidenceFiles.map(file => ({ ...file, path: `reviews/${file.path}` }));
    verifyFiles(sdk.workspace, evidenceRefs, API_BYTES);
    fs.mkdirSync(directory);
    const extension = path.extname(build.artifact);
    if (!['.jar', '.zip'].includes(extension)) throw new Error('CANDIDATE_PACKAGE_INVALID');
    fs.copyFileSync(build.artifact, path.join(directory, `plugin${extension}`), fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(checked.sourceArchive, path.join(directory, 'source.zip'), fs.constants.COPYFILE_EXCL);
    sdk.run('jar', ['--create', '--no-manifest', '--file', path.join(directory, 'review-evidence.zip'), '-C', sdk.workspace, 'reviews']);
    const files = await fileSnapshot(directory, 2 * sdk.invoke({ command: 'limits' }).maxArchiveBytes + API_BYTES);
    const candidate = { schemaVersion: 1, state: 'PENDING_REVIEW', repositoryId: policy.repositoryId,
        repositoryOwnerId: policy.repositoryOwnerId, workflowPath: buildPath, workflowSha: execution.workflowSha,
        runId: execution.runId, runAttempt: execution.runAttempt, pr: checked.pr,
        inputSha256: hash(Buffer.from(JSON.stringify(inputs))), inputs, owner: checked.owner,
        submissionPath: checked.submissionPath, submissionSha256: checked.submissionSha256,
        submission: checked.submission, descriptor: checked.descriptor, publisherKeyFingerprint: checked.publisherKeyFingerprint,
        sourceRepositoryId: checked.sourceRepositoryId, package: checked.package,
        scan, evidence: evidenceRefs, files, measurements: build.measurements,
        compiledClasses: build.compiledClasses, sourceFiles: build.sourceFiles };
    candidateIdentity(candidate);
    const bytes = Buffer.from(JSON.stringify(candidate) + '\n', 'utf8');
    if (bytes.length > API_BYTES) throw new Error('CANDIDATE_SIZE_EXCEEDED');
    fs.writeFileSync(path.join(directory, 'candidate.json'), bytes, { flag: 'wx' });
    return candidate;
}
