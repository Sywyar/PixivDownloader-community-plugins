import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { id } from './github.mjs';
import { sourceFacts, queryModel } from './project.mjs';
import { github, paged, eligible } from './submission-github.mjs';
import { activeKey, publisherPath, bindingPath, versionAvailable, sourceLocation } from './submission-check.mjs';
import { exportKey, keyLocation } from './submission-signing.mjs';
import { licenseFields, marketFields, readFile } from './submission-fields.mjs';
import { download, httpsUrl } from './download.mjs';

export async function signingKey(context, existing, requirePrivate = true) {
    const { sdk, sign, ui, projectRoot } = context;
    const choice = await ui.select('keyAction', ['existingKey', 'generateKey'], value => ui.text(value));
    let publicFile;
    let privateFile;
    let keyId;
    if (choice === 'generateKey') {
        const directory = keyLocation(await ui.ask('keyDirectory', '', value => { keyLocation(value, projectRoot, true); }), projectRoot, true);
        if (!await ui.confirm('generateKey', { directory })) throw new Error('CANCELLED');
        sign('keygen', '--directory', directory);
        publicFile = path.join(directory, 'public-key.pem');
        privateFile = path.join(directory, 'private-key.pem');
        keyId = await ui.ask('keyId', crypto.randomUUID());
    } else {
        publicFile = keyLocation(await ui.ask('publicKey', '', value => { keyLocation(value, projectRoot); }), projectRoot);
        keyId = await ui.ask('keyId', existing?.keyId ?? '');
    }
    const { fingerprint, ...key } = exportKey(sdk, sign, publicFile, keyId);
    if (requirePrivate) privateFile = keyLocation(privateFile ?? await ui.ask('privateKey', '', value => { keyLocation(value, projectRoot); }), projectRoot);
    if (!await ui.confirm('keyAction', { key, fingerprint, publicFile, ...(requirePrivate ? { privateFile } : {}) })) throw new Error('CANCELLED');
    return { key, fingerprint, privateFile };
}

export async function publisherOwner(context, binding) {
    const { ui, state, snapshot, call = github } = context;
    if (binding) {
        if (!eligible(binding.value.owner, snapshot.actor, call)) throw new Error('BINDING_CONFLICT');
        if (binding.value.owner.accountType === 'Organization' && !await ui.confirm('representation', binding.value.owner)) throw new Error('CANCELLED');
        return binding.value.owner;
    }
    const choice = await ui.select('owner', ['personal', 'organization'], value => ui.text(value));
    let account = { id: snapshot.actor.id, type: 'User', login: snapshot.actor.login };
    if (choice === 'organization') {
        const selected = await ui.select('organization', paged('user/orgs', call), organization => organization.login);
        account = { id: id(selected.id), type: 'Organization', login: selected.login };
        if (!eligible({ accountId: account.id, accountType: account.type }, snapshot.actor, call)
            || !await ui.confirm('representation', account)) throw new Error('OWNER_AUTHORIZATION_REQUIRED');
    }
    const publishers = [...state.tree.keys()].filter(file => file.startsWith(`publishers/${account.id}/`) && file.endsWith('.json'));
    const suggestion = publishers.length === 1 ? state.read(publishers[0], 'PUBLISHER').value.publisherId : account.login.toLowerCase();
    const publisherId = await ui.ask('publisher', suggestion);
    const owner = { accountId: account.id, accountType: account.type, publisherId };
    if (!await ui.confirm('publisher', owner)) throw new Error('CANCELLED');
    return owner;
}

export async function prepareRelease(context, selection, profileId) {
    const { sdk, ui, sign, state, snapshot, projectRoot, call = github } = context;
    const source = sourceFacts(projectRoot);
    const license = await licenseFields(sdk, ui, projectRoot, selection.projectDir);
    if (!license) return null;
    if (!await ui.confirm('trust', { project: selection.project, profileId })) throw new Error('CANCELLED');
    const model = await ui.task('model', () => queryModel(sdk, selection, profileId));
    if (!isDeepStrictEqual(sourceFacts(projectRoot), source)) throw new Error('SOURCE_CHANGED_DURING_MODEL_QUERY');
    const artifactPath = await ui.select('artifact', model.artifacts);
    const buildProfile = sdk.invoke({ command: 'select', gitRoot: projectRoot, projectDir: selection.projectDir,
        profileId, artifactPath, outputs: model.artifacts });
    const artifact = path.join(selection.project, artifactPath);
    const facts = await ui.task('inspecting', () => sdk.invoke({ command: 'inspect', file: artifact }));
    if (facts.version !== model.version) throw new Error('MODEL_PACKAGE_VERSION_MISMATCH');
    if (!await ui.confirm('risk', facts.descriptor)) { ui.say('rebuildPackage'); return null; }
    const original = versionAvailable(state, facts.pluginId, facts.version, facts.sha256);
    if (original) return { original };
    const binding = state.read(bindingPath(facts.pluginId), 'BINDING');
    const owner = await publisherOwner(context, binding);
    const publisherFile = publisherPath(owner);
    const existing = state.read(publisherFile, 'PUBLISHER');
    const selectedKey = await signingKey(context, existing ? activeKey(existing.value) : null);
    if (existing && (selectedKey.key.keyId !== activeKey(existing.value).keyId
        || selectedKey.key.publicKeySpkiBase64 !== activeKey(existing.value).publicKeySpkiBase64)) {
        return { rotation: { owner, existing, selectedKey } };
    }
    const changes = new Map();
    if (!existing) {
        const account = owner.accountType === 'User' ? snapshot.actor : call(`organizations/${owner.accountId}`);
        const publisher = { schemaVersion: 1, publisherId: owner.publisherId, displayName: await ui.ask('display', account.login),
            githubAccount: { id: owner.accountId, type: owner.accountType, loginAtRegistration: account.login }, signingKeys: [{ ...selectedKey.key, state: 'ACTIVE' }] };
        sdk.document('PUBLISHER', publisher, publisherFile);
        changes.set(publisherFile, Buffer.from(JSON.stringify(publisher, null, 2) + '\n'));
    }
    const releases = await ui.task('loading', () => paged(`repos/${source.name}/releases`, call).filter(release => !release.draft));
    const release = await ui.select('release', [...releases, null],
        release => release ? `${release.tag_name} (${release.id})` : ui.text('packageUrl'));
    let packageUrl;
    let selectedAsset;
    if (release) {
        selectedAsset = await ui.select('asset', paged(`repos/${source.name}/releases/${id(release.id)}/assets`, call)
            .filter(asset => /\.(jar|zip)$/iu.test(asset.name)), asset => `${asset.name} (${asset.size})`);
        packageUrl = selectedAsset.browser_download_url;
    } else packageUrl = await ui.ask('packageUrl', '', value => { httpsUrl(value); });
    const remotePackage = path.join(sdk.workspace, crypto.randomUUID() + path.extname(artifact));
    await ui.task('downloading', () => download(packageUrl, remotePackage, sdk.invoke({ command: 'limits' }).maxArchiveBytes, { size: facts.size, sha256: facts.sha256 }));
    const signatureFile = path.join(sdk.workspace, crypto.randomUUID() + '.signature.json');
    sign('artifact', '--artifact', remotePackage, '--plugin-id', facts.pluginId, '--version', facts.version,
        '--key-id', selectedKey.key.keyId, '--private-key', selectedKey.privateFile, '--out', signatureFile);
    const fixedSource = { repository: source.repository, commit: source.commit,
        previousReviewedCommit: state.published(facts.pluginId)[0]?.value.sourceCommit ?? null };
    const archiveFile = path.join(sdk.workspace, crypto.randomUUID() + '.zip');
    const archive = await ui.task('downloading', () => download(sourceLocation(fixedSource).url, archiveFile, sdk.invoke({ command: 'limits' }).maxArchiveBytes));
    fixedSource.archive = { url: archive.url, size: archive.size, sha256: archive.sha256 };
    const prior = state.published(facts.pluginId)[0];
    const previousMarket = prior ? sdk.document('SUBMISSION', state.reference(prior.value.submissionRef),
        prior.value.submissionRef.path).value.market : null;
    const market = await marketFields(sdk, ui, owner, facts, changes, previousMarket);
    const submission = { schemaVersion: 1, publisherId: owner.publisherId, pluginId: facts.pluginId, version: facts.version,
        source: fixedSource, buildProfile, license,
        package: { url: packageUrl, expectedSize: facts.size, sha256: facts.sha256, signature: JSON.parse(readFile(signatureFile, 16 * 1024).toString('utf8')) }, market };
    changes.set(`submissions/${owner.accountId}/${facts.pluginId}/${facts.version}.json`, Buffer.from(JSON.stringify(submission, null, 2) + '\n'));
    const recheck = async () => {
        if (!isDeepStrictEqual(sourceFacts(projectRoot), source)) throw new Error('SOURCE_CHANGED');
        const local = sdk.invoke({ command: 'inspect', file: artifact });
        if (local.sha256 !== facts.sha256 || local.size !== facts.size) throw new Error('LOCAL_ARTIFACT_CHANGED');
        if (selectedAsset) {
            const current = call(`repos/${source.name}/releases/assets/${id(selectedAsset.id)}`);
            for (const field of ['id', 'name', 'size', 'browser_download_url', 'updated_at', 'digest']) {
                if (current[field] !== selectedAsset[field]) throw new Error('RELEASE_ASSET_CHANGED');
            }
        }
        await download(packageUrl, path.join(sdk.workspace, crypto.randomUUID() + '.package'), sdk.invoke({ command: 'limits' }).maxArchiveBytes,
            { size: facts.size, sha256: facts.sha256 });
    };
    return { changes, recheck, model, title: `feat(plugin): ${facts.pluginId} ${facts.version}` };
}
