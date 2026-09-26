import path from 'node:path';
import fs from 'node:fs';
import { root } from './sdk.mjs';
import { main, policy } from './github.mjs';
import { preflight, sourceFacts, git } from './project.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { terminal, failureCode, failureDetails } from './submission-ui.mjs';
import { protectedSnapshot, refreshSnapshot, stateReader, eligible, unchanged, github, checkedRepository, requestDetails, authenticationRequired } from './submission-github.mjs';
import { signingTool } from './submission-signing.mjs';
import { prepareRelease } from './submission-release.mjs';
import { prepareRotation, prepareStatus, prepareTransfer, confirmRevocation } from './submission-operations.mjs';
import { withdrawRequest } from './submission-withdraw.mjs';
import { validateChanges, versionAvailable } from './submission-check.mjs';
import { submitPreview, pendingPrepared } from './submission-write.mjs';
import { navigation } from './submission-navigation.mjs';
import { openProject, projectIdentity, openManagement } from './submission-state.mjs';
import { publisherKeys } from './submission-publisher-state.mjs';
import { metadataChanges } from './submission-presentation.mjs';
import { sessionLocator, saveSession, savePrepared, restorePrepared } from './submission-session.mjs';
import { prepareEmergency, validateEmergencySubmission, appliedEmergency } from './submission-emergency.mjs';
import { presentOriginal, requestVersionNotice, versionState, requestedVersionState } from './submission-version-state.mjs';
import { requestRecovery } from './submission-retry.mjs';

function appliedRequest(sdk, state, changes) {
    const kinds = { 'key-rotations': 'ROTATION', 'version-status-requests': 'STATUS_REQUEST', 'ownership-transfers': 'TRANSFER' };
    for (const [file, bytes] of changes) {
        const kind = kinds[file.split('/')[0]];
        if (!kind || file.includes('/approvals/')) continue;
        const request = sdk.document(kind, bytes, file).value;
        const record = state.read(`audits/${request.requestId}.json`, 'AUDIT');
        if (!record) continue;
        const original = state.reference(record.value.requestRef);
        const actual = sdk.invoke({ command: 'canonical', kind, file: sdk.save(original) }).requestId;
        if (actual !== request.requestId) throw new Error('AUDIT_REQUEST_MISMATCH');
        return record;
    }
    return null;
}

export async function runWizard(directory = process.cwd(), { ui: suppliedUi, uiFactory = terminal, call = github, stateHome, prepare = prepareSubmission } = {}) {
    let ui = suppliedUi;
    let sdk;
    let context;
    let closeRecovery;
    try {
        const project = preflight(directory, { allowMissing: true });
        const locator = sessionLocator(project.cwd, stateHome);
        const previous = locator.read();
        const saved = previous && (project.gitRoot || previous.identity.scope === 'community-management') ? previous : null;
        ui ??= await uiFactory({ resumeLocale: saved?.session.locale });
        closeRecovery = requestRecovery(ui.retryRequest);
        if (!project.gitRoot) ui.say('limitedOperations');
        let history = ui.resume && saved ? saved.session.navigation : [];
        context = { ui, projectRoot: project.gitRoot, directory: project.cwd, call,
            bindPublisher(owner) {
                context.publisherOwner = owner;
                context.keyStore = publisherKeys(owner, context.snapshot.actor.id, { home: stateHome });
            },
            bindProject(repositoryId, projectDir, pluginId) {
                if (!project.gitRoot) return;
                const identity = projectIdentity(repositoryId, projectDir, pluginId);
                if (JSON.stringify(context.store?.identity) === JSON.stringify(identity)) return;
                context.store?.close(); context.generatedKey = null; context.sign?.close();
                context.store = openProject(identity, context.snapshot.actor.id, { home: stateHome });
                context.store.update({ session: null });
                saveSession(context, { navigation: history, operation: context.operation,
                    sourceCommit: git(project.gitRoot, 'rev-parse', 'HEAD') });
                locator.bind(context.store, context.snapshot.actor.id);
                ui.say('restored', { projectDir, pluginId, path: context.store.folder });
            } };
        const initialize = async () => {
            if (context.state) return;
            const snapshot = await ui.task('loading', () => protectedSnapshot(call));
            sdk ??= await ui.task('preparing', () => prepare());
            Object.assign(context, { sdk, snapshot, state: stateReader(sdk, snapshot.base, call), sign: context.sign ?? signingTool(sdk) });
            if (!project.gitRoot && !resumePending) {
                context.store = openManagement(snapshot.actor.id, { home: stateHome });
                context.store.update({ session: null });
                saveSession(context, { navigation: history, operation: context.operation, sourceCommit: null });
                locator.bind(context.store, snapshot.actor.id);
            }
        };
        let resumePending = Boolean(ui.resume && saved);
        const restoreSession = async () => {
            if (!resumePending) return;
            await initialize();
            if (context.snapshot.actor.id !== saved.actorId) throw new Error('SESSION_ACCOUNT_CHANGED');
            if (saved.identity.scope !== 'community-management' && saved.session.sourceCommit !== git(project.gitRoot, 'rev-parse', 'HEAD')) throw new Error('SOURCE_CHANGED');
            if (saved.session.operation === 'publish' && String(checkedRepository(sourceFacts(project.gitRoot).name, call).id) !== saved.identity.repositoryId) {
                throw new Error('SESSION_REPOSITORY_CHANGED');
            }
            context.store = saved.identity.scope === 'community-management' ? openManagement(saved.actorId, { home: stateHome })
                : openProject(saved.identity, saved.actorId, { home: stateHome });
            context.generatedKey = context.store.record.session?.generatedKey;
            context.resumePrepared = Boolean(context.store.record.session?.prepared);
            context.operation = saved.session.operation;
            resumePending = false;
        };
        let retryRound = 1, baseRefreshes = 0;
        const retry = async error => {
            if (ui.retryRequest) return ui.retryRequest(error, error.retryRound ?? retryRound++);
            const authentication = authenticationRequired(error.message);
            ui.say(authentication ? 'readingActor' : 'requestFailed', { code: failureCode(error), retryRound: error.retryRound ?? retryRound, ...requestDetails(error), ...failureDetails(error) });
            if (await ui.select(authentication ? 'authenticationRecovery' : 'retrySubmission', ['retry', 'saveExit'],
                key => ui.text(authentication && key === 'retry' ? 'checkAuthentication' : key)) !== 'retry') throw new Error('WIZARD_SAVE');
            retryRound++;
            context.resumePrepared = Boolean(context.store?.record.session?.prepared);
            return true;
        };
        const navigator = navigation(ui, () => context.store, { history, onFailure: retry, onRefresh: async () => {
            if (++baseRefreshes > 3) throw new Error('COMMUNITY_BASE_UNSTABLE');
            await ui.task('loading', () => {
                const snapshot = refreshSnapshot(context.snapshot, call);
                const state = stateReader(sdk, snapshot.masterBase ?? snapshot.base, call);
                Object.assign(context, { snapshot, state, emergency: null,
                    resumePrepared: Boolean(context.store?.record.session?.prepared) });
            });
            ui.say('sessionBaseUpdated');
            return true;
        }, onChange: values => {
            history = values; saveSession(context, { navigation: history, operation: context.operation, prepared: null });
        }, onBack: () => { context.resumePrepared = false; }, onMenu: () => {
            retryRound = 1; baseRefreshes = 0;
            context.store?.update({ session: null });
            context.store?.close(); context.sign?.close();
            Object.assign(context, { store: null, keyStore: null, publisherOwner: null, state: null, emergency: null, generatedKey: null, resumePrepared: false, operation: undefined });
        } });
        context.ui = navigator.ui;
        context.seal = () => navigator.seal();
        context.ui.task = (key, work) => { saveSession(context, { phase: key }); return ui.task(key, work); };
        const outcome = await navigator.run(async ui => {
        await restoreSession();
        if (context.state) unchanged(context.snapshot, call);
        const operations = [...(project.gitRoot ? ['publish'] : []), 'withdraw', 'YANK', 'UNYANK', 'REVOKE', 'rotation', 'transfer', 'emergency'];
        const operation = context.resumePrepared ? context.operation : await ui.select('operation', operations, key => ui.text(key));
        if (!operations.includes(operation)) throw new Error('PROJECT_MARKER_MISSING');
        context.operation = operation;
        await initialize();
        if (operation === 'emergency' && !context.snapshot.branch) {
            const target = protectedSnapshot(call, policy.emergencyBranch);
            if (JSON.stringify(target.actor) !== JSON.stringify(context.snapshot.actor)) throw new Error('COMMUNITY_IDENTITY_CHANGED');
            const previousBase = context.snapshot.base;
            context.snapshot = target;
            if (target.masterBase !== previousBase) throw new Error('COMMUNITY_BASE_CHANGED');
        }
        const { snapshot, state } = context;
        if (operation === 'withdraw') return withdrawRequest(context);
        let prepared;
        if (context.resumePrepared) {
            prepared = await ui.task('restoringSubmission', () => restorePrepared(context));
            if (operation === 'publish' && !prepared.sourceRelease) {
                const files = [...prepared.changes.keys()].filter(file => file.startsWith('submissions/'));
                if (files.length > 1) throw new Error('PROJECT_SESSION_INVALID');
                if (files.length) {
                    const submission = sdk.document('SUBMISSION', prepared.changes.get(files[0]), files[0]).value;
                    prepared.original = versionAvailable(state, submission.pluginId, submission.version, submission.package.sha256);
                }
            }
            if (operation === 'emergency') {
                const original = appliedEmergency(sdk, prepared.changes, call);
                if (original) { presentOriginal(context, original); return { original }; }
                const pending = await ui.task('loading', () => pendingPrepared(snapshot, prepared.changes, call, sdk));
                if (pending) { unchanged(snapshot, call); presentOriginal(context, pending, prepared.changes); return { original: pending }; }
            }
            if (!prepared.original) {
                if (!baseRefreshes && (prepared.snapshot.base !== snapshot.base || prepared.snapshot.masterBase !== snapshot.masterBase)) ui.say('sessionBaseUpdated');
                const pending = await ui.task('loading', () => pendingPrepared(snapshot, prepared.changes, call, sdk));
                if (pending) { unchanged(snapshot, call); presentOriginal(context, pending, prepared.changes); return { original: pending }; }
            }
        }
        else if (operation === 'publish') {
            const projects = sdk.invoke({ command: 'projects', gitRoot: project.gitRoot })
                .filter(item => project.candidates.some(candidate => candidate.projectDir === item.projectDir));
            const selected = projects.length === 1 ? projects[0] : await ui.select('project', projects, item => item.projectDir);
            const profileLabel = value => ({ 'maven-java17-v1': 'Maven · Java 17', 'gradle-java17-v1': 'Gradle · Java 17', 'sbt-java17-v1': 'sbt · Java 17' })[value] ?? value;
            const profile = selected.profiles.length === 1 ? selected.profiles[0] : await ui.select('profile', selected.profiles, profileLabel);
            ui.say('detected', { projectDir: selected.projectDir, profile: profileLabel(profile) });
            prepared = await prepareRelease(context, { ...selected, project: path.resolve(project.gitRoot, selected.projectDir) }, profile);
            if (!prepared) return { sourceChangeRequired: true };
            if (prepared.rotation) prepared = await prepareRotation(context, prepared.rotation);
        } else if (operation === 'emergency') prepared = await prepareEmergency(context);
        else if (operation === 'rotation') prepared = await prepareRotation(context);
        else if (operation === 'transfer') prepared = await prepareTransfer(context);
        else prepared = await prepareStatus(context, operation);
        if (prepared.outcome) return prepared.outcome;
        if (prepared.original) {
            unchanged(snapshot, call);
            presentOriginal(context, prepared.original);
            return { original: prepared.original.value };
        }
        // 原始字节与首次基线共同定位同一投稿；当前主线另行校验，不能覆盖原基线。
        if (!context.resumePrepared) { prepared.snapshot = snapshot; savePrepared(context, prepared); }
        const original = appliedRequest(sdk, state, prepared.changes);
        if (original) {
            unchanged(snapshot, call);
            presentOriginal(context, original);
            return { original: original.value };
        }
        if (context.resumePrepared) requestVersionNotice(context, prepared.changes, true);
        const validate = () => (operation === 'emergency' ? validateEmergencySubmission : validateChanges)({ sdk, state, changes: prepared.changes, user: snapshot.actor, call, ...(prepared.fetch ? { fetch: prepared.fetch } : {}),
            authorize: (owner, user) => eligible(owner, user, call) });
        const result = { ...await ui.task('validating', validate), ...(prepared.sourceRelease ? { sourceRelease: prepared.sourceRelease,
            changes: metadataChanges(prepared.previousMarket, prepared.submission?.market) } : {}) };
        if (['YANK', 'UNYANK', 'REVOKE'].includes(result.operation)) {
            const record = state.published(result.pluginId).find(row => row.value.version === result.version);
            result.currentState = versionState(state, record).currentState;
            const request = sdk.document('STATUS_REQUEST', prepared.changes.get(result.requestPath), result.requestPath).value;
            Object.assign(result, requestedVersionState(state, record, request));
        }
        if (context.resumePrepared) savePrepared(context, prepared);
        return submitPreview({ sdk, snapshot, commitBase: prepared.snapshot.base, changes: prepared.changes, title: prepared.title, result, call,
            actions: prepared.actions, beforeWrite: async () => { navigator.seal(); await prepared.beforeWrite?.(); },
            confirm: async preview => {
                await confirmRevocation(ui, result, prepared.changes);
                return ui.confirm('preview', preview);
            },
            recheck: async () => {
                await ui.task('rechecking', async () => {
                    unchanged(snapshot, call);
                    await prepared.recheck?.();
                    await validate();
                });
            }, write: work => ui.task('writing', work), retry });
        });
        if (outcome.original) { context.store?.complete(outcome); return outcome; }
        if (outcome.sourceChangeRequired) return outcome;
        if (!outcome.cancelled) context.store?.complete({ ...(context.store.record.receipt ?? {}), ...outcome });
        if (!outcome.cancelled && !outcome.withdrawn && ['YANK', 'UNYANK', 'REVOKE'].includes(context.operation)) {
            ui.say('statusRequestSubmitted');
            ui.say('effect' + context.operation);
        }
        ui.say(outcome.transferReviewed ? (outcome.rejected ? 'transferRejected' : outcome.signed ? 'transferSigned' : 'transferApproved') : outcome.cancelled ? 'cancelled' : outcome.withdrawn ? 'withdrawn' : outcome.reused ? 'requestPending' : 'submitted',
            outcome.transferReviewed ? { url: outcome.url } : outcome);
        return outcome;
    } catch (error) {
        if (error.message === 'WIZARD_SAVE') {
            if (!context?.store) { ui?.say(ui?.resume ? 'saved' : 'cancelled'); return ui?.resume ? { saved: true } : { cancelled: true }; }
            ui?.say('saved', { path: context.store.folder }); return { saved: true };
        }
        if (error.message === 'CANCELLED') { ui?.say('cancelled'); return { cancelled: true }; }
        // 原生命令输出可能含凭据，只投影受控错误码与诊断字段。
        const code = failureCode(error);
        if (ui) ui.say(code.startsWith('DOWNLOAD_') ? 'downloadFailed' : 'failed', { code, ...requestDetails(error), ...failureDetails(error),
            ...(error.statePath || code === 'COMMUNITY_BASE_UNSTABLE' && context.store
                ? { path: error.statePath ?? context.store.folder } : {}) });
        else console.error(code);
        process.exitCode = 1;
        return { failed: code };
    } finally {
        closeRecovery?.();
        context?.sign?.close();
        try { context?.store?.close(); } catch { ui?.say('cleanupFailed', { workspace: context.store.folder }); }
        try {
            if (sdk && path.dirname(sdk.workspace) === path.resolve(root, 'target')
                && /^community-[A-Za-z0-9]+$/u.test(path.basename(sdk.workspace))
                && fs.realpathSync(sdk.workspace) === sdk.workspace) fs.rmSync(sdk.workspace, { recursive: true });
        } catch { ui.say('cleanupFailed', { workspace: sdk.workspace }); }
        finally { ui?.close(); }
    }
}

main(import.meta.url, async () => {
    if (process.argv.length > 3) throw new Error('SUBMISSION_ARGUMENTS_INVALID');
    try {
        const { runInteractive } = await import('./submission-terminal.mjs');
        const outcome = await runInteractive(process.argv[2]);
        if (outcome?.failed) process.exitCode = 1;
    }
    catch (error) { throw new Error(failureCode(error)); }
});
