import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileSnapshot, fileDifference, dependencyContent } from '../build-files.mjs';
import { root, hash } from '../sdk.mjs';

test('清点实际源码和缓存，绑定字节差异并拒绝超限及链接逃逸', async () => {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(root, 'target/files-'));
    const source = path.join(directory, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'dependency.jar'), 'old');
    fs.writeFileSync(path.join(source, 'removed.txt'), 'remove');
    const before = await fileSnapshot(source, 100);
    assert.equal(before.find(file => file.path === 'dependency.jar').sha256, hash(Buffer.from('old')));
    fs.writeFileSync(path.join(source, 'dependency.jar'), 'new');
    fs.unlinkSync(path.join(source, 'removed.txt'));
    fs.writeFileSync(path.join(source, 'added.txt'), 'add');
    const delta = fileDifference(before, await fileSnapshot(source, 100));
    assert.deepEqual(delta.added.map(file => file.path), ['added.txt']);
    assert.deepEqual(delta.removed.map(file => file.path), ['removed.txt']);
    assert.deepEqual(delta.changed.map(file => file.path), ['dependency.jar']);
    await assert.rejects(fileSnapshot(source, 2), /BUILD_FILES_SIZE_EXCEEDED/u);
    assert.deepEqual((await fileSnapshot(source, 100, file => file.endsWith('.jar'))).map(file => file.path), ['dependency.jar']);
    fs.symlinkSync(directory, path.join(source, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(fileSnapshot(source, 100), /BUILD_FILE_NOT_REGULAR/u);
});

test('依赖清点保留非 JAR 制品，缓存锁和下载状态不冒充依赖内容', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'target/cache-'));
    const artifact = '.gradle/caches/modules-2/files-2.1/example/native/1/hash/library.so';
    const marker = '.cache/coursier/v1/https/repo.example/artifact/.library.so.checked';
    for (const file of [artifact, marker]) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), 'before');
    }
    const before = await fileSnapshot(directory, 100);
    for (const file of [artifact, marker]) fs.writeFileSync(path.join(directory, file), 'after');
    const changed = fileDifference(before, await fileSnapshot(directory, 100)).changed;
    assert.equal(changed.length, 2);
    assert.deepEqual(changed.filter(file => dependencyContent(file.path)).map(file => file.path), [artifact]);
    for (const file of ['.m2/repository/example/library/1/library.aar', '.cache/coursier/v1/https/repo.example/library.klib',
        '.ivy2/cache/example/library/native/library.so', '.sbt/boot/scala-library.jar']) assert(dependencyContent(file));
    for (const file of ['.m2/repository/_remote.repositories', '.m2/repository/library.jar.lastUpdated',
        '.gradle/caches/cache.lock']) assert(!dependencyContent(file));
});
