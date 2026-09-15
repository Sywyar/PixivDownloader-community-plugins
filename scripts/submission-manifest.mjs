import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { main } from './github.mjs';
import { root, hash } from './sdk.mjs';

export function submissionManifest(directory = root) {
    const selected = new Set();
    const visit = relative => {
        if (selected.has(relative)) return;
        selected.add(relative);
        const source = fs.readFileSync(path.join(directory, relative), 'utf8');
        for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/gu)) {
            if (match[1].startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
            else if (!match[1].startsWith('node:')) throw new Error('SUBMISSION_DEPENDENCY_UNPINNED');
        }
    };
    visit('scripts/submit.mjs');
    selected.add('scripts/repository-policy.json');
    for (const name of ['CommunityReview.java', 'CommunitySubmission.java', 'CommunitySource.java',
        'sdk-tools.jar', 'sdk-lock.json', 'community-contract.json', 'signing-tool.jar', 'signing-tool.json']) selected.add('tools/' + name);
    for (const file of fs.readdirSync(path.join(directory, 'schemas/community/v1'), { recursive: true, withFileTypes: true })) {
        if (file.isFile()) selected.add(path.relative(directory, path.join(file.parentPath, file.name)).split(path.sep).join('/'));
        else if (!file.isDirectory()) throw new Error('SUBMISSION_RESOURCE_INVALID');
    }
    const files = [...selected].sort().map(relative => {
        const file = path.join(directory, relative);
        if (!fs.lstatSync(file).isFile()) throw new Error('SUBMISSION_RESOURCE_INVALID');
        const bytes = fs.readFileSync(file);
        return { path: relative, size: bytes.length, sha256: hash(bytes) };
    });
    return { schemaVersion: 1, files };
}

main(import.meta.url, () => {
    const manifest = submissionManifest();
    const file = path.join(root, 'tools/submission-files.json');
    if (process.argv.length === 3 && process.argv[2] === '--write') fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    else if (process.argv.length !== 2 || !isDeepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), manifest)) throw new Error('SUBMISSION_MANIFEST_CHANGED');
    console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.files.reduce((sum, row) => sum + row.size, 0), sha256: hash(fs.readFileSync(file)) }));
});
