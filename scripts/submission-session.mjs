import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { API_BYTES, sha } from './github.mjs';
import { hash } from './sdk.mjs';
import { sourceFacts } from './project.mjs';
import { readFile } from './submission-fields.mjs';
import { projectFolder, projectIdentity, submissionHome, STATE_BYTES, writeState } from './submission-state.mjs';
import { sourceCandidate } from './submission-candidate.mjs';
import { locales } from './submission-ui.mjs';
import { versionAvailable } from './submission-check.mjs';

// 启动目录只定位上次使用的项目；恢复前仍须用 GitHub 数字身份和当前源码核对。
export function sessionLocator(directory, home = submissionHome()) {
    const sourceRoot = fs.realpathSync(directory);
    const file = path.join(home, 'launches', hash(Buffer.from(sourceRoot)), 'last-session.json');
    return {
        read() {
            if (!fs.existsSync(file)) return null;
            try {
                const ref = JSON.parse(readFile(file, STATE_BYTES).toString('utf8'));
                if (ref.schemaVersion !== 1 || ref.sourceRoot !== sourceRoot || !/^[1-9][0-9]*$/u.test(ref.actorId)) throw new Error();
                const identity = projectIdentity(ref.identity.repositoryId, ref.identity.projectDir, ref.identity.pluginId);
                const profile = path.join(projectFolder(identity, home), 'profile.json');
                if (!fs.existsSync(profile)) return null;
                const data = JSON.parse(readFile(profile, STATE_BYTES).toString('utf8'));
                if (data.schemaVersion !== 1 || !isDeepStrictEqual(data.identity, identity)) throw new Error();
                const session = data.actors?.[ref.actorId]?.session;
                if (!session) return null;
                if (session.schemaVersion !== 1 || !Array.isArray(session.navigation)
                    || !['publish', 'YANK', 'UNYANK', 'REVOKE', 'rotation', 'transfer', 'emergency'].includes(session.operation)
                    || !locales.includes(session.locale)
                    || session.navigation.some(answer => !answer || !Array.isArray(answer.signature)
                        || !['ask', 'select', 'multiselect', 'confirm'].includes(answer.signature[0]))) throw new Error();
                return { identity, actorId: ref.actorId, session };
            } catch { throw Object.assign(new Error('PROJECT_SESSION_INVALID'), { statePath: file }); }
        },
        bind(store, actorId) { writeState(file, { schemaVersion: 1, sourceRoot, identity: store.identity, actorId }); },
    };
}

export function saveSession(context, values) {
    if (!context.store) return;
    context.store.update({ session: { schemaVersion: 1, locale: context.ui.locale, navigation: [],
        ...context.store.record.session, ...values, updatedAt: new Date().toISOString() } });
}

function pendingFile(store, digest) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('PROJECT_SESSION_INVALID');
    return path.join(store.folder, `pending-${digest}.bin`);
}

export function savePrepared(context, prepared) {
    if (!context.store) return;
    const files = [...prepared.changes].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: hash(bytes) }));
    const size = files.reduce((sum, file) => sum + file.size, 0);
    if (size > API_BYTES) throw new Error('INPUT_SIZE_EXCEEDED');
    const bytes = Buffer.concat([...prepared.changes.values()]);
    if (/-----BEGIN (?:ENCRYPTED |OPENSSH |RSA |EC )?PRIVATE KEY-----/u.test(bytes.toString('utf8'))) throw new Error('PRIVATE_KEY_IN_SUBMISSION');
    const digest = hash(bytes); const target = pendingFile(context.store, digest);
    if (fs.existsSync(target)) {
        if (!readFile(target, API_BYTES).equals(bytes)) throw new Error('PROJECT_SESSION_CHANGED');
    } else fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    saveSession(context, { prepared: { files, size, digest, title: prepared.title,
        snapshot: context.snapshot, source: prepared.sourceRelease ? sourceFacts(context.projectRoot) : null,
        sourceRelease: prepared.sourceRelease ?? null, previousMarket: prepared.previousMarket ?? null } });
}

export function preparedChanges(store) {
    const prepared = store.record.session?.prepared;
    if (!prepared) return null;
    const bytes = readFile(pendingFile(store, prepared.digest), API_BYTES);
    if (bytes.length !== prepared.size || hash(bytes) !== prepared.digest || !Array.isArray(prepared.files)) throw new Error('PROJECT_SESSION_CHANGED');
    let offset = 0; const changes = new Map();
    for (const file of prepared.files) {
        if (typeof file.path !== 'string' || changes.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0
            || offset + file.size > bytes.length) throw new Error('PROJECT_SESSION_INVALID');
        const content = bytes.subarray(offset, offset + file.size); offset += file.size;
        if (hash(content) !== file.sha256) throw new Error('PROJECT_SESSION_CHANGED');
        changes.set(file.path, content);
    }
    if (offset !== bytes.length || !changes.size) throw new Error('PROJECT_SESSION_INVALID');
    return { ...prepared, changes };
}

export async function restorePrepared(context) {
    const prepared = preparedChanges(context.store);
    if (!prepared) return null;
    // 主线前进不改变已签名的请求字节；调用方仍须按当前状态完整校验并重新确认。
    sha(prepared.snapshot?.base);
    if (!isDeepStrictEqual({ ...prepared.snapshot, base: context.snapshot.base,
        ...(context.snapshot.masterBase ? { masterBase: context.snapshot.masterBase } : {}) }, context.snapshot)) throw new Error('SESSION_IDENTITY_CHANGED');
    if (!prepared.sourceRelease) return prepared;
    const source = sourceFacts(context.projectRoot);
    if (!isDeepStrictEqual(source, prepared.source)) throw new Error('SOURCE_CHANGED');
    const files = [...prepared.changes.keys()].filter(file => file.startsWith('submissions/'));
    if (files.length !== 1) throw new Error('PROJECT_SESSION_INVALID');
    const submission = context.sdk.document('SUBMISSION', prepared.changes.get(files[0]), files[0]).value;
    const original = versionAvailable(context.state, submission.pluginId, submission.version, submission.package.sha256);
    if (original) return { ...prepared, original };
    const candidate = await sourceCandidate({ ...context, resumeCandidateId: prepared.sourceRelease.id, resumeCandidateTag: prepared.sourceRelease.tag }, source,
        { projectDir: submission.buildProfile.projectDir }, submission.buildProfile.id);
    if (candidate.sourceRelease.repository !== prepared.sourceRelease.repository || candidate.sourceRelease.tag !== prepared.sourceRelease.tag
        || candidate.packageUrl !== submission.package.url
        || candidate.facts.sha256 !== submission.package.sha256 || candidate.facts.size !== submission.package.expectedSize) throw new Error('CANDIDATE_PREVIEW_CHANGED');
    return { ...prepared, submission, fetch: candidate.fetch, beforeWrite: candidate.beforeWrite, actions: candidate.actions,
        recheck: async () => {
            if (!isDeepStrictEqual(sourceFacts(context.projectRoot), source)) throw new Error('SOURCE_CHANGED');
            await candidate.recheck();
        } };
}
