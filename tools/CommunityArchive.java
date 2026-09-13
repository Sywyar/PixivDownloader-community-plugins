import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipFile;
import top.sywyar.pixivdownload.common.Utf8ConsoleStreams;
import top.sywyar.pixivdownload.plugin.runtime.install.model.PluginPackageLimits;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Reference;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;

/** 只解包声明的普通数据文件；不加载投稿类，不执行归档中的脚本。 */
public final class CommunityArchive {
    private static final int REPORT_BYTES = 32 * 1024 * 1024;

    public static void main(String[] args) throws Exception {
        Utf8ConsoleStreams.install();
        if (args.length == 4 && args[0].equals("reports")) {
            byte[] manifest;
            try (var stream = Files.newInputStream(Path.of(args[1]), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                manifest = stream.readNBytes(REPORT_BYTES + 1);
            }
            var candidate = CommunityJson.strictTree(manifest, REPORT_BYTES);
            unpack(Path.of(args[2]), Path.of(args[3]), references(candidate.get("evidence"), true, REPORT_BYTES), REPORT_BYTES);
            return;
        }
        if (args.length != 3) throw new IllegalArgumentException("ARCHIVE_ARGUMENTS");
        Path archive = Path.of(args[0]), output = Path.of(args[1]);
        long packageBytes = PluginPackageLimits.defaults().maxArchiveBytes();
        long maximum = 2 * packageBytes + 2L * REPORT_BYTES;
        if (Files.size(archive) > maximum) throw new IOException("ARCHIVE_SIZE_EXCEEDED");
        byte[] manifest;
        try (var zip = new ZipFile(archive.toFile())) {
            var entry = zip.getEntry("candidate.json");
            if (entry == null || entry.isDirectory()) throw new IOException("CANDIDATE_MISSING");
            try (var stream = zip.getInputStream(entry)) { manifest = stream.readNBytes(REPORT_BYTES + 1); }
        }
        var candidate = CommunityJson.strictTree(manifest, REPORT_BYTES);
        var files = references(candidate.get("files"), false, packageBytes);
        files.put("candidate.json", Reference.of("candidate.json", manifest));
        Files.createDirectory(output);
        unpack(archive, output, files, maximum);
        var reports = references(candidate.get("evidence"), true, REPORT_BYTES);
        unpack(output.resolve("review-evidence.zip"), Path.of(args[2]), reports, REPORT_BYTES);
        System.out.println(new String(manifest, java.nio.charset.StandardCharsets.UTF_8));
    }

    private static Map<String, Reference> references(com.fasterxml.jackson.databind.JsonNode values, boolean reports, long maximum) throws IOException {
        if (values == null || !values.isArray()) throw new IOException("ARCHIVE_FILES_INVALID");
        var result = new HashMap<String, Reference>();
        for (var value : values) {
            var ref = new com.fasterxml.jackson.databind.ObjectMapper().treeToValue(value, Reference.class);
            String pattern = reports ? "reviews/evidence/[a-f0-9]{64}\\.json" : "(?:plugin\\.(?:jar|zip)|source\\.zip|review-evidence\\.zip)";
            if (!ref.path().matches(pattern) || ref.size() < 0 || ref.size() > maximum
                    || !ref.sha256().matches("[a-f0-9]{64}") || result.put(ref.path(), ref) != null) throw new IOException("ARCHIVE_FILES_INVALID");
        }
        if (!reports && (result.size() != 3 || !result.containsKey("source.zip") || !result.containsKey("review-evidence.zip"))) {
            throw new IOException("ARCHIVE_FILES_INVALID");
        }
        return result;
    }

    private static void unpack(Path archive, Path output, Map<String, Reference> files, long maximum) throws IOException {
        var seen = new HashSet<String>();
        long total = 0;
        try (var zip = new ZipFile(archive.toFile())) {
            if (zip.size() > PluginPackageLimits.defaults().maxEntries()) throw new IOException("ARCHIVE_ENTRIES_EXCEEDED");
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (!seen.add(entry.getName())) throw new IOException("ARCHIVE_DUPLICATE");
                if (entry.isDirectory()) {
                    if (!Set.of("reviews/", "reviews/evidence/").contains(entry.getName())) throw new IOException("ARCHIVE_PATH_INVALID");
                    continue;
                }
                var ref = files.get(entry.getName());
                if (ref == null || ref.size() > maximum - total) throw new IOException("ARCHIVE_FILES_INVALID");
                byte[] bytes;
                try (var stream = zip.getInputStream(entry)) { bytes = stream.readNBytes(Math.toIntExact(ref.size() + 1)); }
                total += bytes.length;
                ref.verify(bytes);
                Path file = CommunityPaths.resolve(output, ref.path(), false, false);
                Files.createDirectories(file.getParent());
                if (Files.exists(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) ref.verify(output);
                else Files.write(file, bytes, StandardOpenOption.CREATE_NEW);
            }
        }
        if (!seen.containsAll(files.keySet())) throw new IOException("ARCHIVE_FILE_MISSING");
    }
}
