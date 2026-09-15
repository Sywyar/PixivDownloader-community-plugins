import path from 'node:path';
import fs from 'node:fs';
import { root } from './sdk.mjs';
import { main } from './github.mjs';
import { preflight, markerMissing } from './project.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { terminal, failureCode } from './submission-ui.mjs';
import { protectedSnapshot, stateReader, eligible, unchanged, github } from './submission-github.mjs';
import { signingTool } from './submission-signing.mjs';
import { prepareRelease } from './submission-release.mjs';
import { prepareRotation, prepareStatus, prepareTransfer } from './submission-operations.mjs';
import { validateChanges } from './submission-check.mjs';
import { submitPreview } from './submission-write.mjs';
import { navigation } from './submission-navigation.mjs';
import { openProject, projectIdentity } from './submission-state.mjs';
import { metadataChanges } from './submission-presentation.mjs';

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

export async function runWizard(directory = process.cwd(), { ui: suppliedUi, uiFactory = terminal, call = github } = {}) {
    // 在创建缓存、查询账号或执行工程前检查 SDK 标识。
    const project = preflight(directory);
    let ui = suppliedUi;
    let sdk;
    let context;
    try {
        ui ??= await uiFactory();
        context = { ui, projectRoot: project.gitRoot, call,
            bindProject(repositoryId, projectDir, pluginId) {
                const identity = projectIdentity(repositoryId, projectDir, pluginId);
                if (JSON.stringify(context.store?.identity) === JSON.stringify(identity)) return;
                context.store?.close(); context.generatedKey = null; context.sign.close();
                context.store = openProject(identity, context.snapshot.actor.id);
                ui.say('restored', { projectDir, pluginId, path: context.store.folder });
            } };
        const navigator = navigation(ui, () => context.store);
        context.ui = navigator.ui;
        const outcome = await navigator.run(async ui => {
        const operation = await ui.select('operation', ['publish', 'YANK', 'UNYANK', 'REVOKE', 'transfer'], key => ui.text(key));
        if (!sdk) {
            sdk = await ui.task('preparing', () => prepareSubmission());
            const snapshot = await ui.task('loading', () => protectedSnapshot(call));
            Object.assign(context, { sdk, snapshot, state: stateReader(sdk, snapshot.base, call), sign: signingTool(sdk) });
        }
        const { snapshot, state } = context;
        let prepared;
        if (operation === 'publish') {
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
        } else if (operation === 'transfer') prepared = await prepareTransfer(context);
        else prepared = await prepareStatus(context, operation);
        const original = appliedRequest(sdk, state, prepared.changes);
        if (original) {
            unchanged(snapshot, call);
            ui.say('original', original.value);
            return { original: original.value };
        }
        const validate = () => validateChanges({ sdk, state, changes: prepared.changes, user: snapshot.actor, call, ...(prepared.fetch ? { fetch: prepared.fetch } : {}),
            authorize: (owner, user) => eligible(owner, user, call) });
        const result = { ...await ui.task('validating', validate), ...(prepared.sourceRelease ? { sourceRelease: prepared.sourceRelease,
            changes: metadataChanges(prepared.previousMarket, prepared.submission?.market) } : {}) };
        return submitPreview({ sdk, snapshot, changes: prepared.changes, title: prepared.title, result, call,
            actions: prepared.actions, beforeWrite: async () => { navigator.seal(); await prepared.beforeWrite?.(); },
            confirm: preview => ui.confirm('preview', preview),
            recheck: async () => {
                await ui.task('rechecking', async () => {
                    unchanged(snapshot, call);
                    await prepared.recheck?.();
                    await validate();
                });
            }, write: work => ui.task('writing', work), retry: async error => {
                ui.say('requestFailed', { code: failureCode(error), status: error.status, attempts: error.attempts });
                if (await ui.select('retrySubmission', ['retry', 'saveExit'], key => ui.text(key)) === 'retry') return true;
                throw new Error('WIZARD_SAVE');
            } });
        });
        if (outcome.sourceChangeRequired || outcome.original) return outcome;
        if (!outcome.cancelled) context.store?.complete({ ...(context.store.record.receipt ?? {}), ...outcome });
        ui.say(outcome.cancelled ? 'cancelled' : 'submitted', outcome);
        return outcome;
    } catch (error) {
        if (error.message === 'WIZARD_SAVE') {
            if (!context?.store) { ui?.say('cancelled'); return { cancelled: true }; }
            ui?.say('saved', { path: context.store.folder }); return { saved: true };
        }
        if (error.message === 'CANCELLED') { ui?.say('cancelled'); return { cancelled: true }; }
        // 原生命令错误可能包含工程输出，只向终端投影固定错误码。
        const code = failureCode(error);
        const stage = ['DNS', 'PROXY', 'PROXY_CONNECT', 'CONNECT', 'BODY'].includes(error.downloadStage) ? error.downloadStage : undefined;
        if (ui) ui.say(code.startsWith('DOWNLOAD_') ? 'downloadFailed' : 'failed', { code, ...(stage ? { stage } : {}),
            ...(error.github ? { status: error.status, attempts: error.attempts } : {}),
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
