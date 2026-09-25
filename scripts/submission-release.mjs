import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { id } from './github.mjs';
import { sourceFacts } from './project.mjs';
import { github, paged, eligible, repositoryTree, readBlob } from './submission-github.mjs';
import { policy } from './github.mjs';
import { sourceCandidate } from './submission-candidate.mjs';
import { activeKey, publisherPath, bindingPath, versionAvailable, sourceLocation } from './submission-check.mjs';
import { exportKey, keyLocation, keyDirectory, unlockPrivateKey } from './submission-signing.mjs';
import { licenseFields, marketFields, readFile } from './submission-fields.mjs';
import { download } from './download.mjs';
import { saveSession } from './submission-session.mjs';
import { hash } from './sdk.mjs';
import { keyLabel } from './submission-emergency.mjs';

export async function signingKey(context, registeredKeys = [], { rotation = false } = {}) {
    const { sdk, sign, ui, projectRoot, store } = context;
    const keyStore = context.keyStore ?? store;
    const owner = context.publisherOwner ?? context.keyStore?.identity;
    if (owner && registeredKeys.length) ui.say('keyContext', registeredKeys.map(key => keyLabel(context, owner, key)));
    const active = registeredKeys.find(key => key.state === 'ACTIVE');
    const activeFingerprint = active && hash(Buffer.from(active.publicKeySpkiBase64, 'base64'));
    const remembered = (!rotation && activeFingerprint && (keyStore?.key(activeFingerprint) ?? store?.key(activeFingerprint)))
        || keyStore?.record.key || store?.record.key;
    const choice = await ui.select('keyAction', ['existingKey', 'generateKey'], value => ui.text(value));
    let publicFile;
    let privateFile;
    const readPublicKey = file => {
        const exported = exportKey(sdk, sign, keyLocation(file, projectRoot), crypto.randomUUID());
        if (rotation && registeredKeys.some(key => key.publicKeySpkiBase64 === exported.publicKeySpkiBase64)) {
            throw new Error('KEY_PUBLIC_REUSED');
        }
        return exported;
    };
    if (choice === 'generateKey') {
        const parent = await ui.ask('keyDirectory', remembered?.directory ?? os.homedir(), value => { keyDirectory(value, projectRoot); }, { remember: false });
        const protection = await ui.select('keyProtection', ['protectedKey', 'plainKey'], value => ui.text(value));
        const generated = context.generatedKey;
        if (generated && path.dirname(path.resolve(generated.directory)) !== path.resolve(generated.parent)) throw new Error('PROJECT_SESSION_INVALID');
        const directory = generated?.parent === parent && generated?.protection === protection ? generated.directory : keyDirectory(parent, projectRoot);
        if (!await ui.confirm('generateKey', { directory, protection })) throw new Error('CANCELLED');
        publicFile = path.join(directory, 'public-key.pem');
        privateFile = path.join(directory, 'private-key.pem');
        if (generated?.directory !== directory) {
            if (protection === 'protectedKey') {
                const password = await ui.password('password', value => { if (Buffer.byteLength(value, 'utf8') > 4096) throw new Error('INPUT_SIZE_EXCEEDED'); });
                await ui.password('passwordAgain', value => { if (value !== password) throw new Error('KEY_PASSWORD_MISMATCH'); });
                sign.password(privateFile, password);
            }
            sign('keygen', '--directory', directory);
            context.generatedKey = { parent, protection, directory, keyId: crypto.randomUUID() };
            // 生成后立即保存定位信息，取消或保存退出也能找到已经落盘的私钥。
            saveSession(context, { generatedKey: context.generatedKey });
        }
    } else {
        publicFile = keyLocation(await ui.ask('publicKey', remembered?.publicFile ?? '', value => { readPublicKey(value); }, { remember: false }), projectRoot);
    }
    const { fingerprint, ...key } = readPublicKey(publicFile);
    const registered = registeredKeys.find(item => item.publicKeySpkiBase64 === key.publicKeySpkiBase64);
    const previous = keyStore?.key(fingerprint) ?? store?.key(fingerprint);
    // 社区登记优先；旧版缓存可能把新公钥错误地配到已登记的旧 keyId。
    const reused = value => registeredKeys.some(item => item.keyId === value && item.publicKeySpkiBase64 !== key.publicKeySpkiBase64)
        || [...Object.values(keyStore?.record.keys ?? {}), remembered]
            .some(item => item?.keyId === value && item.fingerprint && item.fingerprint !== fingerprint);
    const knownId = registered?.keyId ?? (previous && !reused(previous.keyId) ? previous.keyId : undefined);
    const suggestedId = knownId ?? (choice === 'generateKey' ? context.generatedKey.keyId : key.keyId);
    ui.say('keyIdHelp');
    key.keyId = await ui.ask('keyId', suggestedId, value => {
        sdk.invoke({ command: 'field', field: 'keyId', value });
        if (knownId && value !== knownId) throw new Error('KEY_ID_MISMATCH');
        if (!registered && reused(value)) throw new Error('KEY_ID_REUSED');
    }, { identity: fingerprint, remember: false });
    privateFile = keyLocation(privateFile ?? await ui.ask('privateKey', previous?.privateFile ?? '', value => { keyLocation(value, projectRoot); },
        { identity: fingerprint, remember: false }), projectRoot);
    await unlockPrivateKey(context, privateFile, publicFile);
    if (!await ui.confirm('keyAction', { key, fingerprint, publicFile, privateFile })) throw new Error('CANCELLED');
    keyStore?.update({ key: { keyId: key.keyId, fingerprint, publicFile, privateFile,
        directory: choice === 'generateKey' ? context.generatedKey.parent : path.dirname(publicFile) } });
    store?.remember('keyAction:0', 'existingKey');
    return { key, fingerprint, privateFile };
}

export async function publisherOwner(context, binding, { ownerLabel = 'owner', publisherLabel = 'publisher' } = {}) {
    const { ui, state, snapshot, call = github } = context;
    if (binding) {
        if (!eligible(binding.value.owner, snapshot.actor, call)) throw new Error('BINDING_CONFLICT');
        if (binding.value.owner.accountType === 'Organization' && !await ui.confirm('representation', binding.value.owner)) throw new Error('CANCELLED');
        return binding.value.owner;
    }
    const choice = await ui.select(ownerLabel, ['personal', 'organization'], value => ui.text(value));
    let account = { id: snapshot.actor.id, type: 'User', login: snapshot.actor.login };
    if (choice === 'organization') {
        const organizations = paged('user/orgs', call);
        const selectedId = await ui.select('organization', organizations.map(value => id(value.id)),
            value => organizations.find(organization => id(organization.id) === value).login);
        const selected = organizations.find(value => id(value.id) === selectedId);
        account = { id: id(selected.id), type: 'Organization', login: selected.login };
        if (!eligible({ accountId: account.id, accountType: account.type }, snapshot.actor, call)
            || !await ui.confirm('representation', account)) throw new Error('OWNER_AUTHORIZATION_REQUIRED');
    }
    const publishers = [...state.tree.keys()].filter(file => file.startsWith(`publishers/${account.id}/`) && file.endsWith('.json'));
    const suggestion = publishers.length === 1 ? state.read(publishers[0], 'PUBLISHER').value.publisherId : account.login.toLowerCase();
    const publisherId = await ui.ask(publisherLabel, suggestion, value => context.sdk.invoke({ command: 'field', field: 'publisher', value }));
    const owner = { accountId: account.id, accountType: account.type, publisherId };
    if (!await ui.confirm(publisherLabel, owner)) throw new Error('CANCELLED');
    return owner;
}

export async function prepareRelease(context, selection, profileId) {
    const { sdk, ui, sign, state, snapshot, projectRoot, call = github } = context;
    const source = sourceFacts(projectRoot);
    ui.say('loading');
    const candidate = await sourceCandidate(context, source, selection, profileId);
    const { facts, artifact, packageUrl } = candidate;
    const buildProfile = candidate.candidate.buildProfile;
    const original = versionAvailable(state, facts.pluginId, facts.version, facts.sha256);
    if (original) return { original };
    const binding = state.read(bindingPath(facts.pluginId), 'BINDING');
    if (binding && !eligible(binding.value.owner, snapshot.actor, call)) throw new Error('PLUGIN_ID_ALREADY_BOUND');
    const pending = pendingVersion(context, facts, source, binding);
    if (pending) return { original: { value: pending } };
    const prior = state.published(facts.pluginId)[0];
    const previous = prior ? sdk.document('SUBMISSION', state.reference(prior.value.submissionRef), prior.value.submissionRef.path).value : null;
    const license = await licenseFields(sdk, ui, projectRoot, selection.projectDir, previous?.license ?? context.store?.record.license);
    if (!license) return null;
    if (!await ui.confirm('risk', facts.descriptor)) { ui.say('rebuildPackage'); return null; }
    const owner = await publisherOwner(context, binding);
    context.bindPublisher?.(owner);
    const publisherFile = publisherPath(owner);
    const existing = state.read(publisherFile, 'PUBLISHER');
    const selectedKey = await signingKey(context, existing?.value.signingKeys ?? []);
    if (existing && (selectedKey.key.keyId !== activeKey(existing.value).keyId
        || selectedKey.key.publicKeySpkiBase64 !== activeKey(existing.value).publicKeySpkiBase64)) {
        return { rotation: { owner, existing, selectedKey } };
    }
    const changes = new Map();
    if (!existing) {
        const account = owner.accountType === 'User' ? snapshot.actor : call(`organizations/${owner.accountId}`);
        const publisher = { schemaVersion: 1, publisherId: owner.publisherId, displayName: await ui.ask('display', account.login,
            value => sdk.invoke({ command: 'field', field: 'display', value })),
            githubAccount: { id: owner.accountId, type: owner.accountType, loginAtRegistration: account.login }, signingKeys: [{ ...selectedKey.key, state: 'ACTIVE' }] };
        sdk.document('PUBLISHER', publisher, publisherFile);
        changes.set(publisherFile, Buffer.from(JSON.stringify(publisher, null, 2) + '\n'));
    }
    const signatureFile = path.join(sdk.workspace, crypto.randomUUID() + '.signature.json');
    sign('artifact', '--artifact', artifact, '--plugin-id', facts.pluginId, '--version', facts.version,
        '--key-id', selectedKey.key.keyId, '--private-key', selectedKey.privateFile, '--out', signatureFile);
    const fixedSource = { repository: source.repository, commit: source.commit,
        previousReviewedCommit: state.published(facts.pluginId)[0]?.value.sourceCommit ?? null };
    const archiveFile = path.join(sdk.workspace, crypto.randomUUID() + '.zip');
    const archive = await ui.task('downloadingSource', () => download(sourceLocation(fixedSource).url, archiveFile, sdk.invoke({ command: 'limits' }).maxArchiveBytes));
    fixedSource.archive = { url: archive.url, size: archive.size, sha256: archive.sha256 };
    const market = await marketFields(sdk, ui, owner, facts, changes, previous?.market ?? context.store?.record.market, file => {
        if (state.tree.has(file)) return state.raw(file);
        const old = context.store?.record.marketAssets?.[file];
        const cached = old && context.store.cached(old.sha256, old.size);
        return cached ? readFile(cached, old.size) : null;
    });
    const marketAssets = {};
    for (const [file, bytes] of changes) if (file.startsWith('assets/')) {
        const sha256 = (await import('./sdk.mjs')).hash(bytes);
        context.store?.retain(sdk.save(bytes), sha256, bytes.length);
        marketAssets[file] = { sha256, size: bytes.length };
    }
    context.store?.update({ license, market, marketAssets });
    const submission = { schemaVersion: 1, publisherId: owner.publisherId, pluginId: facts.pluginId, version: facts.version,
        source: fixedSource, buildProfile, license,
        package: { url: packageUrl, expectedSize: facts.size, sha256: facts.sha256, signature: JSON.parse(readFile(signatureFile, 16 * 1024).toString('utf8')) }, market };
    changes.set(`submissions/${owner.accountId}/${facts.pluginId}/${facts.version}.json`, Buffer.from(JSON.stringify(submission, null, 2) + '\n'));
    const recheck = async () => {
        if (!isDeepStrictEqual(sourceFacts(projectRoot), source)) throw new Error('SOURCE_CHANGED');
        const local = sdk.invoke({ command: 'inspect', file: artifact });
        if (local.sha256 !== facts.sha256 || local.size !== facts.size) throw new Error('LOCAL_ARTIFACT_CHANGED');
        if (pendingVersion(context, facts, source, binding)) throw new Error('VERSION_SUBMISSION_CONFLICT');
        await candidate.recheck();
    };
    return { changes, recheck, beforeWrite: candidate.beforeWrite, fetch: candidate.fetch, actions: candidate.actions,
        sourceRelease: candidate.sourceRelease, previousMarket: previous?.market, submission,
        title: `feat(plugin): ${facts.pluginId} ${facts.version}` };
}

// 查重只阻止重复投稿，不能授予插件所有权；最终静态检查和受保护 Gate 仍重新验证身份。
export function pendingVersion(context, facts, source, binding) {
    const { call = github, sdk, snapshot } = context;
    const matches = [];
    for (const pull of paged(`repos/${policy.repository}/pulls?state=open`, call)) {
        const files = paged(`repos/${policy.repository}/pulls/${id(pull.number)}/files`, call);
        const submissions = files
            .filter(file => file.filename.startsWith('submissions/') && file.filename.split('/')[2] === facts.pluginId);
        if (!submissions.length) continue;
        if (!pull.head?.repo || id(pull.base.repo.id) !== policy.repositoryId) throw new Error('PENDING_SUBMISSION_CONFLICT');
        const tree = repositoryTree(pull.head.repo.full_name, pull.head.sha, call);
        for (const file of submissions) {
            const bytes = readBlob(pull.head.repo.full_name, tree.get(file.filename), call);
            const value = sdk.document('SUBMISSION', bytes, file.filename).value;
            const changes = new Map([[file.filename, bytes]]);
            const publisherFile = `publishers/${file.filename.split('/')[1]}/${value.publisherId}.json`;
            if (files.some(item => item.filename === publisherFile)) changes.set(publisherFile, readBlob(pull.head.repo.full_name, tree.get(publisherFile), call));
            if (!binding) {
                const accountId = file.filename.split('/')[1];
                const publisher = context.state.read(publisherFile, 'PUBLISHER')
                    ?? sdk.document('PUBLISHER', changes.get(publisherFile) ?? readBlob(pull.head.repo.full_name, tree.get(publisherFile), call), publisherFile);
                if (publisher.value.githubAccount.id !== accountId || !eligible({ accountId,
                    accountType: publisher.value.githubAccount.type }, snapshot.actor, call)) throw new Error('PLUGIN_ID_SUBMISSION_CONFLICT');
            }
            if (value.version !== facts.version) continue;
            if (id(pull.user.id) !== snapshot.actor.id || value.package.sha256 !== facts.sha256 || value.source.commit !== source.commit) throw new Error('VERSION_SUBMISSION_CONFLICT');
            matches.push({ url: pull.html_url, head: pull.head.sha, pluginId: facts.pluginId, version: facts.version,
                reused: true, draft: Boolean(pull.draft), changes });
        }
    }
    if (matches.length > 1) throw new Error('VERSION_SUBMISSION_CONFLICT');
    return matches[0] ?? null;
}
