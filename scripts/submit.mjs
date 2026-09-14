import path from 'node:path';
import fs from 'node:fs';
import { root } from './sdk.mjs';
import { main } from './github.mjs';
import { preflight, markerMissing } from './project.mjs';
import { prepareSubmission } from './submission-sdk.mjs';
import { terminal } from './submission-ui.mjs';
import { protectedSnapshot, stateReader, eligible, unchanged, github } from './submission-github.mjs';
import { signingTool } from './submission-signing.mjs';
import { prepareRelease } from './submission-release.mjs';
import { prepareRotation, prepareStatus, prepareTransfer } from './submission-operations.mjs';
import { validateChanges } from './submission-check.mjs';
import { submitPreview } from './submission-write.mjs';

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

export async function runWizard(directory = process.cwd(), { ui: suppliedUi, call = github } = {}) {
    // 在创建缓存、查询账号或执行工程前检查 SDK 标识。
    const project = preflight(directory);
    let ui = suppliedUi;
    let sdk;
    try {
        ui ??= await terminal();
        const operation = await ui.select('operation', ['publish', 'YANK', 'UNYANK', 'REVOKE', 'transfer'], key => ui.text(key));
        sdk = await ui.task('preparing', () => prepareSubmission());
        const { snapshot, state } = await ui.task('loading', () => {
            const snapshot = protectedSnapshot(call);
            return { snapshot, state: stateReader(sdk, snapshot.base, call) };
        });
        const context = { sdk, snapshot, state, ui, sign: signingTool(sdk), projectRoot: project.gitRoot, call };
        let prepared;
        if (operation === 'publish') {
            const projects = sdk.invoke({ command: 'projects', gitRoot: project.gitRoot })
                .filter(item => project.candidates.some(candidate => candidate.projectDir === item.projectDir));
            const selected = await ui.select('project', projects, item => item.projectDir);
            const profile = await ui.select('profile', selected.profiles);
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
        const validate = () => validateChanges({ sdk, state, changes: prepared.changes, user: snapshot.actor, call,
            authorize: (owner, user) => eligible(owner, user, call) });
        const result = { ...await ui.task('validating', validate), ...(prepared.model ? { model: prepared.model } : {}) };
        const outcome = await submitPreview({ sdk, snapshot, changes: prepared.changes, title: prepared.title, result, call,
            confirm: preview => ui.confirm('preview', preview),
            recheck: async () => {
                await ui.task('rechecking', async () => {
                    unchanged(snapshot, call);
                    await prepared.recheck?.();
                    await validate();
                });
                ui.say('writing');
            } });
        ui.say(outcome.cancelled ? 'cancelled' : 'submitted', outcome);
        return outcome;
    } catch (error) {
        if (error.message === 'CANCELLED') { ui?.say('cancelled'); return { cancelled: true }; }
        // 原生命令错误可能包含工程输出，只向终端投影固定错误码。
        const code = /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message
            : /ContractException: ([A-Z][A-Z0-9_]+)/u.exec(String(error.stderr ?? ''))?.[1] ?? 'SUBMISSION_FAILED';
        const stage = ['DNS', 'PROXY', 'PROXY_CONNECT', 'CONNECT', 'BODY'].includes(error.downloadStage) ? error.downloadStage : undefined;
        if (ui) ui.say(code.startsWith('DOWNLOAD_') ? 'downloadFailed' : 'failed', { code, ...(stage ? { stage } : {}) });
        else console.error(code);
        process.exitCode = 1;
        return { failed: code };
    } finally {
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
    try { await runWizard(process.argv[2]); }
    catch (error) { throw new Error(error.message === markerMissing ? markerMissing : 'PROJECT_PREFLIGHT_FAILED'); }
});
