import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { main } from './github.mjs';
import { root, hash } from './sdk.mjs';
import { governanceSources } from './community-tools.mjs';
import { foundationLock } from './foundation-resources.mjs';

export function submissionManifest(directory = root) {
    const foundation = foundationLock(directory);
    const version = JSON.parse(fs.readFileSync(path.join(directory, 'tools/governance/version.json'), 'utf8')).version;
    const selected = new Set();
    const visit = relative => {
        if (selected.has(relative)) return;
        selected.add(relative);
        const source = fs.readFileSync(path.join(directory, relative), 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu)) {
            if (match[1].startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
            else if (!match[1].startsWith('node:')) throw new Error('SUBMISSION_DEPENDENCY_UNPINNED');
        }
        for (const match of source.matchAll(/new URL\(\s*['"](\.[^'"]+\.mjs)['"],\s*import\.meta\.url\)/gu)) {
            visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
        }
    };
    visit('scripts/submit.mjs');
    selected.add('scripts/repository-policy.json');
    for (const file of [...governanceSources(directory), 'tools/governance/version.json', 'tools/foundation-lock.json']) selected.add(file);
    const files = [...selected].sort().map(relative => {
        const file = path.join(directory, relative);
        if (!fs.lstatSync(file).isFile()) throw new Error('SUBMISSION_RESOURCE_INVALID');
        const bytes = fs.readFileSync(file);
        return { path: relative, size: bytes.length, sha256: hash(bytes) };
    });
    return { schemaVersion: 2, tool: { version, foundationSha256: foundation.sha256 }, files };
}

main(import.meta.url, () => {
    const manifest = submissionManifest();
    const file = path.join(root, 'tools/submission-files.json');
    if (process.argv.length === 3 && process.argv[2] === '--write') fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    else if (process.argv.length !== 2 || !isDeepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), manifest)) throw new Error('SUBMISSION_MANIFEST_CHANGED');
    console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((sum, row) => sum + row.size, 0), sha256: hash(fs.readFileSync(file)) }));
});
