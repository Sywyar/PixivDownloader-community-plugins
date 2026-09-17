import path from 'node:path';
import fs from 'node:fs';
import { root } from './sdk.mjs';
import { main, policy } from './github.mjs';
import { preflight, markerMissing, sourceFacts, git } from './project.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { terminal, failureCode } from './submission-ui.mjs';
import { protectedSnapshot, stateReader, eligible, unchanged, github, checkedRepository, requestDetails } from './submission-github.mjs';
import { signingTool } from './submission-signing.mjs';
import { prepareRelease } from './submission-release.mjs';
import { prepareRotation, prepareStatus, prepareTransfer, confirmRevocation } from './submission-operations.mjs';
import { withdrawRequest } from './submission-withdraw.mjs';
import { validateChanges } from './submission-check.mjs';
import { submitPreview, pendingPrepared } from './submission-write.mjs';
import { navigation } from './submission-navigation.mjs';
import { openProject, projectIdentity } from './submission-state.mjs';
import { publisherKeys } from './submission-publisher-state.mjs';
import { metadataChanges } from './submission-presentation.mjs';
import { sessionLocator, saveSession, savePrepared, restorePrepared } from './submission-session.mjs';
import { prepareEmergency, validateEmergencySubmission, appliedEmergency } from './submission-emergency.mjs';

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
    // 在创建缓存、查询账号或执行工程前检查 SDK 标识。
    const project = preflight(directory);
    let ui = suppliedUi;
    let sdk;
    let context;
    try {
        const locator = sessionLocator(project.cwd, stateHome);
        const saved = locator.read();
        ui ??= await uiFactory({ resumeLocale: saved?.session.locale });
        let history = ui.resume && saved ? saved.session.navigation : [];
        context = { ui, projectRoot: project.gitRoot, call,
            bindPublisher(owner) {
                context.publisherOwner = owner;
                context.keyStore = publisherKeys(owner, context.snapshot.actor.id, { home: stateHome });
            },
            bindProject(repositoryId, projectDir, pluginId) {
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
            sdk ??= await ui.task('preparing', () => prepare());
            const snapshot = await ui.task('loading', () => protectedSnapshot(call));
            Object.assign(context, { sdk, snapshot, state: stateReader(sdk, snapshot.base, call), sign: context.sign ?? signingTool(sdk) });
        };
        let resumePending = Boolean(ui.resume && saved);
        const restoreSession = async () => {
            if (!resumePending) return;
            await initialize();
            if (context.snapshot.actor.id !== saved.actorId) throw new Error('SESSION_ACCOUNT_CHANGED');
            if (saved.session.sourceCommit !== git(project.gitRoot, 'rev-parse', 'HEAD')) throw new Error('SOURCE_CHANGED');
            if (saved.session.operation === 'publish' && String(checkedRepository(sourceFacts(project.gitRoot).name, call).id) !== saved.identity.repositoryId) {
                throw new Error('SESSION_REPOSITORY_CHANGED');
            }
            context.store = openProject(saved.identity, saved.actorId, { home: stateHome });
            context.generatedKey = context.store.record.session?.generatedKey;
            context.resumePrepared = Boolean(context.store.record.session?.prepared);
            context.operation = saved.session.operation;
            resumePending = false;
        };
        const retry = async error => {
            ui.say('requestFailed', { code: failureCode(error), ...requestDetails(error) });
            if (await ui.select('retrySubmission', ['retry', 'saveExit'], key => ui.text(key)) !== 'retry') throw new Error('WIZARD_SAVE');
            context.resumePrepared = Boolean(context.store?.record.session?.prepared);
            return true;
        };
        const navigator = navigation(ui, () => context.store, { history, onFailure: retry, onChange: values => {
            history = values; saveSession(context, { navigation: history, operation: context.operation, prepared: null });
        }, onBack: () => { context.resumePrepared = false; }, onMenu: () => {
            context.store?.update({ session: null });
            context.store?.close(); context.sign?.close();
            Object.assign(context, { store: null, keyStore: null, publisherOwner: null, state: null, generatedKey: null, resumePrepared: false, operation: undefined });
        } });
        context.ui = navigator.ui;
        context.ui.task = (key, work) => { saveSession(context, { phase: key }); return ui.task(key, work); };
        const outcome = await navigator.run(async ui => {
        await restoreSession();
        if (context.state) unchanged(context.snapshot, call);
        const operation = context.resumePrepared ? context.operation : await ui.select('operation', ['publish', 'withdraw', 'YANK', 'UNYANK', 'REVOKE', 'rotation', 'transfer', 'emergency'], key => ui.text(key));
        context.operation = operation;
        await initialize();
        if (operation === 'emergency' && !context.snapshot.branch) {
            const target = protectedSnapshot(call, policy.emergencyBranch);
            if (target.masterBase !== context.snapshot.base) throw new Error('IDENTITY_OR_BASE_CHANGED');
            context.snapshot = target;
        }
        const { snapshot, state } = context;
        if (operation === 'withdraw') return withdrawRequest(context);
        let prepared;
        if (context.resumePrepared) {
            prepared = await ui.task('restoringSubmission', () => restorePrepared(context));
            if (operation === 'emergency') {
                const original = appliedEmergency(sdk, prepared.changes, call);
                if (original) { ui.say('original', original); return { original }; }
                const pending = await ui.task('loading', () => pendingPrepared(snapshot, prepared.changes, call, sdk));
                if (pending) { unchanged(snapshot, call); ui.say('original', pending); return { original: pending }; }
            }
            if (prepared.snapshot.base !== snapshot.base) {
                ui.say('sessionBaseUpdated');
                const pending = await ui.task('loading', () => pendingPrepared(snapshot, prepared.changes, call, sdk));
                if (pending) { unchanged(snapshot, call); ui.say('original', pending); return { original: pending }; }
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
            if (prepared.original) {
                unchanged(snapshot, call);
                ui.say('original', prepared.original.value);
                return { original: prepared.original.value };
            }
            if (prepared.rotation) prepared = await prepareRotation(context, prepared.rotation);
        } else if (operation === 'emergency') prepared = await prepareEmergency(context);
        else if (operation === 'rotation') prepared = await prepareRotation(context);
        else if (operation === 'transfer') prepared = await prepareTransfer(context);
        else prepared = await prepareStatus(context, operation);
        // 首次准备先保存原始字节；恢复时须通过当前主线校验后才替换旧快照。
        if (!context.resumePrepared) savePrepared(context, prepared);
        const original = appliedRequest(sdk, state, prepared.changes);
        if (original) {
            unchanged(snapshot, call);
            ui.say('original', original.value);
            return { original: original.value };
        }
        const validate = () => (operation === 'emergency' ? validateEmergencySubmission : validateChanges)({ sdk, state, changes: prepared.changes, user: snapshot.actor, call, ...(prepared.fetch ? { fetch: prepared.fetch } : {}),
            authorize: (owner, user) => eligible(owner, user, call) });
        const result = { ...await ui.task('validating', validate), ...(prepared.sourceRelease ? { sourceRelease: prepared.sourceRelease,
            changes: metadataChanges(prepared.previousMarket, prepared.submission?.market) } : {}) };
        if (context.resumePrepared) savePrepared(context, prepared);
        return submitPreview({ sdk, snapshot, changes: prepared.changes, title: prepared.title, result, call,
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
        ui.say(outcome.cancelled ? 'cancelled' : outcome.withdrawn ? 'withdrawn' : 'submitted', outcome);
        return outcome;
    } catch (error) {
        if (error.message === 'WIZARD_SAVE') {
            if (!context?.store) { ui?.say(ui?.resume ? 'saved' : 'cancelled'); return ui?.resume ? { saved: true } : { cancelled: true }; }
            ui?.say('saved', { path: context.store.folder }); return { saved: true };
        }
        if (error.message === 'CANCELLED') { ui?.say('cancelled'); return { cancelled: true }; }
        // 原生命令错误可能包含工程输出，只向终端投影固定错误码。
        const code = failureCode(error);
        if (ui) ui.say(code.startsWith('DOWNLOAD_') ? 'downloadFailed' : 'failed', { code, ...requestDetails(error),
            ...(error.statePath ? { path: error.statePath } : {}) });
        else console.error(code);
        process.exitCode = 1;
        return { failed: code };
    } finally {
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
    catch (error) { throw new Error(error.message === markerMissing ? markerMissing : 'PROJECT_PREFLIGHT_FAILED'); }
});
