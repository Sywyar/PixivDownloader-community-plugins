import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash } from './sdk.mjs';
import { policy, API_BYTES } from './github.mjs';
import { catalogId } from './platform.mjs';
import { publisherPath } from './submission-check.mjs';

export const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
export const rawUrl = file => `https://raw.githubusercontent.com/${policy.repository}/${policy.defaultBranch}/${file}`;
export const formalTag = record => `${record.owner.publisherId}/${record.pluginId}-v${record.version}`;
export const packageName = record => `pixivdownload-plugin-${record.owner.publisherId}-${record.pluginId}-${record.version}${new URL(record.package.url).pathname.endsWith('.zip') ? '.zip' : '.jar'}`;
export const packageUrl = record => `https://github.com/${policy.repository}/releases/download/${formalTag(record)}/${packageName(record)}`;

export function refreshIdentity(state) {
    const bytes = state.raw('generated/current.json');
    if (!bytes) throw new Error('GENERATION_BASELINE_MISSING');
    return hash(encoded({ operation: 'REFRESH', currentSha256: hash(bytes) }));
}

export function releaseStatus(record, revocations) {
    const matches = revocations.entries.filter(entry => (entry.pluginId == null || entry.pluginId === record.pluginId)
        && (entry.version == null || entry.version === record.version)
        && (entry.packageSha256 == null || entry.packageSha256 === record.package.sha256)
        && (entry.keyId == null || entry.keyId === record.communitySignature.keyId)
        && (entry.publisherId == null || entry.publisherId === record.owner.publisherId));
    return matches.some(entry => entry.action === 'REVOKED') ? 'REVOKED' : matches.some(entry => entry.action === 'YANKED') ? 'YANKED' : 'ACTIVE';
}

export function generateState({ sdk, adapter, state, writes, communityKey, privateBytes, appliedAt, nextUpdate, decision }) {
    const raw = file => writes.get(file) ?? state.raw(file);
    const json = file => { const bytes = raw(file); return bytes ? JSON.parse(bytes.toString('utf8')) : null; };
    const reference = ref => { const bytes = raw(ref.path); if (!bytes || bytes.length !== ref.size || hash(bytes) !== ref.sha256) throw new Error('GENERATION_REFERENCE_CHANGED'); return bytes; };
    const previous = json('generated/current.json');
    const sequence = (previous?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('GENERATION_SEQUENCE_EXHAUSTED');
    const originalKey = json('generated/community-key.json');
    if (originalKey && !isDeepStrictEqual(originalKey, communityKey)) throw new Error('COMMUNITY_ROOT_CHANGED');
    writes.set('generated/community-key.json', encoded(communityKey));
    const published = [...new Set([...state.tree.keys(), ...writes.keys()])].filter(file => /^published\/[^/]+\/[^/]+\.json$/u.test(file))
        .map(file => sdk.document('PUBLISHED', raw(file), file).value).sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.publishedAt.localeCompare(b.publishedAt));
    const restrictions = json('revocations/restrictions.json') ?? [];
    for (const item of published) {
        if (item.communitySignature.keyId !== communityKey.keyId) throw new Error('COMMUNITY_ROOT_CHANGED');
        const publisher = json(publisherPath(item.owner));
        const original = JSON.parse(reference(item.historicalPublisherRef).toString('utf8'));
        const before = original.signingKeys.find(key => key.keyId === item.package.signature.keyId);
        const now = publisher?.signingKeys.find(key => key.keyId === item.package.signature.keyId);
        if (!before || !now || before.publicKeySpkiBase64 !== now.publicKeySpkiBase64) throw new Error('HISTORICAL_PUBLISHER_CHANGED');
        if (now.state === 'REVOKED' && !restrictions.some(row => row.communityIndependent && row.entry.packageSha256 === item.package.sha256 && row.entry.action === 'REVOKED')) {
            restrictions.push({ decisionRef: decision, communityIndependent: true, entry: { scope: 'PACKAGE_SHA256', pluginId: item.pluginId,
                version: item.version, packageSha256: item.package.sha256, keyId: null, publisherId: null, action: 'REVOKED', reasonCode: 'KEY_COMPROMISE', effectiveTime: appliedAt } });
        }
    }
    for (const row of restrictions) if (!adapter.records.has(row.decisionRef.path)) adapter.archive(reference(row.decisionRef), row.decisionRef.path);
    const currentRevocations = json('revocations.json');
    const revocationSequence = currentRevocations?.sequence ?? 0;
    const changedRestrictions = !isDeepStrictEqual(restrictions, json('revocations/restrictions.json') ?? []);
    const fresh = writes.has('revocations.json') && currentRevocations?.generatedTime === appliedAt && !changedRestrictions;
    const resultingSequence = revocationSequence + (fresh ? 0 : 1);
    const revocations = fresh ? raw('revocations.json') : Buffer.from(adapter.invoke({ command: 'revocations',
        repositoryId: catalogId, sequence: resultingSequence, appliedAt, nextUpdate, restrictions }).bytes, 'base64');
    writes.set('revocations.json', revocations);
    writes.set('revocations/restrictions.json', encoded(restrictions));
    const groups = new Map();
    for (const record of published) {
        const review = JSON.parse(reference(record.reviewRef).toString('utf8'));
        const submission = JSON.parse(reference(record.submissionRef).toString('utf8'));
        const manager = json(`plugin-bindings/${record.pluginId}.json`);
        if (!manager) throw new Error('BINDING_MISSING');
        const restricted = releaseStatus(record, JSON.parse(revocations)) !== 'ACTIVE';
        const entry = groups.get(record.pluginId) ?? { pluginId: record.pluginId, packages: [] };
        entry.market = { ...submission.market, author: record.owner.publisherId, sourceType: 'community', license: submission.license.expression,
            homepageUrl: submission.source.repository, updatedTime: record.publishedAt };
        entry.owner = manager.owner;
        entry.packages.push({ version: record.version, packageUrl: packageUrl(record), expectedSizeBytes: record.package.expectedSize,
            sha256: record.package.sha256, signature: record.communitySignature, requiredSdk: review.descriptor.requiredSdk,
            dependencies: review.descriptor.dependencies.map(dependency => dependency.pluginId + (dependency.requirement.present ? '@' + dependency.requirement.raw : '')),
            releasedTime: record.publishedAt, deprecated: restricted,
            assuranceLevel: record.assuranceLevel, sourceCommit: record.sourceCommit, reviewRef: record.reviewRef, historicalOwner: record.owner });
        groups.set(record.pluginId, entry);
    }
    const directory = `generated/generations/${sequence}`;
    const put = (name, bytes) => { const file = `${directory}/${name}`; const ref = adapter.archive(bytes, file); writes.set(file, bytes); return ref; };
    const sign = (kind, ref, seq) => adapter.invoke({ command: 'sign', kind, communityKey, repositoryId: catalogId,
        document: ref, ...(seq ? { sequence: seq } : {}) }, privateBytes);
    const catalog = put('catalog.json', encoded({ schemaVersion: '1', generatedTime: appliedAt, entries: [...groups.values()] }));
    const catalogSignature = encoded(sign('manifest', catalog));
    put('catalog.json.sig', catalogSignature);
    writes.set('generated/catalog.json', writes.get(catalog.path));
    writes.set('generated/catalog.json.sig', catalogSignature);
    const revocationRef = put('revocations.json', revocations);
    const revocationSignature = encoded(sign('revocations', revocationRef, JSON.parse(revocations.toString('utf8')).sequence));
    put('revocations.json.sig', revocationSignature);
    writes.set('revocations.json.sig', revocationSignature);
    const descriptor = put('repository.json', encoded({ schemaVersion: 1, repositoryId: catalogId, displayName: 'PixivDownloader Community',
        publisher: { id: 'community', displayName: 'PixivDownloader Community', homepageUrl: `https://github.com/${policy.repository}` },
        catalog: { protocol: 'manifest-v1', endpoint: rawUrl('generated/catalog.json') }, networkProfile: 'GITHUB_RELEASES', revocationsUrl: rawUrl('revocations.json'),
        trustedKeys: [{ keyId: communityKey.keyId, algorithm: communityKey.algorithm, publicKeySpkiBase64: communityKey.publicKeySpkiBase64,
            state: communityKey.state, publisher: communityKey.publisher, trustLabel: communityKey.trustLabel }] }));
    writes.set('generated/repository.json', writes.get(descriptor.path));
    const keyFingerprint = hash(Buffer.from(communityKey.publicKeySpkiBase64, 'base64'));
    const generated = adapter.invoke({ command: 'directory', repositoryId: catalogId, sequence, appliedAt, entries: [{
        repositoryId: catalogId, descriptorUrl: rawUrl('generated/repository.json'), descriptorSha256: descriptor.sha256,
        publisher: { accountId: policy.repositoryOwnerId, accountType: 'User', publisherId: 'community' }, publisherLoginSnapshot: policy.repository.split('/')[0],
        certificationRef: decision, certifiedKeys: [{ keyId: communityKey.keyId, spkiSha256: keyFingerprint }], status: 'IDENTITY_VERIFIED',
        firstReviewedAt: previous?.firstReviewedAt ?? appliedAt, lastReviewedAt: appliedAt, directorySequence: sequence, githubRepositoryId: policy.repositoryId }] });
    let directoryRef;
    for (const [name, value] of Object.entries(generated)) { const ref = put(name, Buffer.from(value, 'base64')); if (name === 'directory.json') directoryRef = ref; }
    const directorySignature = sign('directory', directoryRef, sequence);
    put('directory.json.sig', encoded(directorySignature));
    adapter.invoke({ command: 'verify-generation', communityKey, repositoryId: catalogId,
        directory: directoryRef, directorySignature, rootUrl: rawUrl(directoryRef.path),
        shards: [...adapter.records.values()].filter(ref => ref.path.startsWith(`${directory}/shards/`)),
        catalog, catalogSignature: JSON.parse(catalogSignature), revocations: revocationRef, revocationSignature: JSON.parse(revocationSignature) });
    writes.set('generated/current.json', encoded({ schemaVersion: 1, sequence, firstReviewedAt: previous?.firstReviewedAt ?? appliedAt,
        directory: directoryRef, directorySignature, descriptor, catalog, revocations: revocationRef }));
    for (const [file, ref] of adapter.records) if (!writes.has(file) && !state.raw(file)) writes.set(file, fs.readFileSync(path.join(adapter.workspace, ref.path)));
    if ([...writes.values()].reduce((size, bytes) => size + bytes.length, 0) > API_BYTES) throw new Error('GENERATION_SIZE_EXCEEDED');
    return { sequence, published, current: JSON.parse(writes.get('generated/current.json')) };
}
