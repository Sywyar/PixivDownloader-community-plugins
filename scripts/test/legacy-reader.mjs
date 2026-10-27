import fs from 'node:fs';
import path from 'node:path';
import { root } from '../sdk.mjs';
import { download } from '../download.mjs';
import { fileMatches, plainPath } from '../foundation-resources.mjs';

// 此固定历史发行只用于旧客户端兼容回归，生产工具不读取此路径或归档。
const baseline = JSON.parse(fs.readFileSync(new URL('fixtures/published-sdk.json', import.meta.url), 'utf8'));

export async function verifyLegacyReviews(sdk, writes, { withContent = false } = {}) {
    const selected = withContent ? baseline.newer : baseline;
    const directory = fs.mkdtempSync(path.join(sdk.workspace, 'legacy-client-'));
    try {
        const archive = path.join(root, 'target/sdk', selected.archive.sha256 + '.zip');
        if (!fileMatches(archive, selected.archive)) {
            fs.mkdirSync(path.dirname(archive), { recursive: true });
            await download(`https://github.com/Sywyar/PixivDownloader-Plugin-SDK/releases/download/sdk-api-v${selected.version}/${selected.archive.file}`,
                archive, selected.archive.size, selected.archive);
        }
        sdk.run('jar', ['--extract', '--file', archive, selected.tool.path], directory);
        const tool = path.join(directory, selected.tool.path);
        if (!fileMatches(tool, selected.tool)) throw new Error('LEGACY_TOOL_CHANGED');
        sdk.run('jar', ['--extract', '--file', tool, 'BOOT-INF/classes', 'BOOT-INF/lib'], directory);
        const classpath = [path.join(directory, 'BOOT-INF/classes'), path.join(directory, 'BOOT-INF/lib/*'), directory].join(path.delimiter);
        const source = path.join(directory, 'LegacyReader.java');
        fs.writeFileSync(source, `import java.nio.file.*;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.review.CommunityReview;
public class LegacyReader {
    public static void main(String[] args) throws Exception {
        var document = CommunityJson.parse(CommunityJson.Kind.REVIEW, Files.readAllBytes(Path.of(args[0])));
        var review = CommunityReview.read(document);
        if (!review.assuranceLevel().equals("SOURCE_REVIEWED")) throw new AssertionError();
        System.out.println(document.sha256());
    }
}`, 'utf8');
        sdk.run('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', classpath, '-d', directory, source]);
        let count = 0;
        for (const [name, bytes] of writes) if (/^reviews\/[^/]+\/[^/]+\.json$/u.test(name) && !name.startsWith('reviews/evidence/')) {
            const file = path.join(directory, 'review.json'); fs.writeFileSync(file, bytes);
            sdk.run('java', ['-cp', classpath, 'LegacyReader', file]);
            count++;
        }
        if (!count) throw new Error('LEGACY_REVIEW_NOT_EXERCISED');
    } finally {
        plainPath(directory);
        fs.rmSync(directory, { recursive: true });
    }
}
