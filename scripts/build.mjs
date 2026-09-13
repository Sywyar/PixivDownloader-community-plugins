import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildPolicy, withBuildSandbox } from './build-sandbox.mjs';
import { fileSnapshot, fileDifference, dependencyContent } from './build-files.mjs';
import { readModel } from './project.mjs';
import { API_BYTES } from './github.mjs';

/** 调用方已经核验源码归档与发布者原包；只返回本次离线重建的实际事实。 */
export async function rebuild(sdk, { submission, sourceRoot, packageFile }, tools, directory) {
    const profile = submission.buildProfile;
    const pristine = await fileSnapshot(sourceRoot, buildPolicy.diskBytes);
    const original = sdk.invoke({ command: 'inspect', file: packageFile });
    if (original.sha256 !== submission.package.sha256 || original.size !== submission.package.expectedSize) throw new Error('BUILD_ORIGINAL_CHANGED');
    return withBuildSandbox(async sandbox => {
        const source = path.join(sandbox.writable, 'source');
        fs.cpSync(sourceRoot, source, { recursive: true, errorOnExist: true, force: false });
        const command = proxy => ['/tools/node/bin/node', '/tools/scripts/build-profile.mjs', profile.id, profile.projectDir, proxy];
        const prefetch = await sandbox.run({ phase: 'prefetch', tools, online: true, command: command(sandbox.proxyAddress) });
        const cache = path.join(sandbox.writable, 'home');
        const dependencies = () => fileSnapshot(cache, buildPolicy.diskBytes);
        const dependencyFiles = await dependencies();
        // 清除预取生成的工程内容，再从同一已核验源码重建；没有共享可写缓存。
        if (path.dirname(source) !== sandbox.writable) throw new Error('BUILD_SOURCE_ROOT_INVALID');
        fs.rmSync(source, { recursive: true });
        fs.cpSync(sourceRoot, source, { recursive: true, errorOnExist: true, force: false });
        if (!isDeepStrictEqual(await fileSnapshot(source, buildPolicy.diskBytes), pristine)) throw new Error('BUILD_SOURCE_CHANGED');
        const rebuilt = await sandbox.run({ phase: 'rebuild', tools, command: command('none') });
        const dependencyChanges = fileDifference(dependencyFiles, await dependencies());
        if ([...dependencyChanges.changed, ...dependencyChanges.removed].some(file => dependencyContent(file.path))) {
            throw new Error('BUILD_DEPENDENCY_CHANGED');
        }
        const dependencyMetadata = sdk.invoke({ command: 'dependency-metadata', root: cache,
            files: dependencyFiles.filter(file => file.path.endsWith('.pom')) });
        const modelFile = path.join(sandbox.writable, 'model-output.txt');
        if (!fs.lstatSync(modelFile).isFile() || fs.statSync(modelFile).size > API_BYTES) throw new Error('BUILD_MODEL_INVALID');
        const model = readModel(sdk, profile.id, fs.readFileSync(modelFile, 'utf8'), path.join(sandbox.writable, 'effective-pom.xml'));
        const containerProject = path.posix.resolve('/work/source', profile.projectDir);
        if (!Array.isArray(model.artifacts) || !model.artifacts.every(file => typeof file === 'string' && path.posix.isAbsolute(file))) {
            throw new Error('BUILD_MODEL_INVALID');
        }
        const outputs = model.artifacts.map(file => path.posix.relative(containerProject, file));
        if (!outputs.includes(profile.artifactPath) || model.version !== submission.version) throw new Error('BUILD_MODEL_MISMATCH');
        if (!Array.isArray(model.classDirectories)) throw new Error('BUILD_MODEL_INVALID');
        const compiledClasses = [];
        for (const classes of model.classDirectories) {
            if (typeof classes !== 'string' || !path.posix.isAbsolute(classes)) throw new Error('BUILD_MODEL_INVALID');
            const relative = path.posix.relative('/work/source', classes);
            const checked = sdk.invoke({ command: 'path', root: source, path: relative, mustExist: false }).path;
            if (fs.existsSync(checked)) {
                for (const file of await fileSnapshot(checked, buildPolicy.diskBytes, name => name.endsWith('.class'))) {
                    compiledClasses.push({ ...file, path: path.posix.join(relative, file.path) });
                }
            }
        }
        const artifact = sdk.invoke({ command: 'path', root: source,
            path: path.posix.join(profile.projectDir, profile.artifactPath), mustExist: true }).path;
        const actual = sdk.invoke({ command: 'inspect', file: artifact });
        if (actual.sha256 !== original.sha256 || actual.size !== original.size
            || !fs.readFileSync(artifact).equals(fs.readFileSync(packageFile))) throw new Error('BUILD_PACKAGE_MISMATCH');
        const output = path.join(sandbox.workspace, 'rebuilt' + path.extname(packageFile));
        fs.copyFileSync(artifact, output, fs.constants.COPYFILE_EXCL);
        return { workspace: sandbox.workspace, artifact: output, package: actual, model, jdkVersion: rebuilt.jdkVersion,
            dependencyFiles, dependencyMetadata, compiledClasses, sourceFiles: pristine, measurements: { prefetch, rebuild: rebuilt } };
    }, { directory });
}
