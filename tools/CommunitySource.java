import com.fasterxml.jackson.databind.JsonNode;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.HashSet;
import java.util.Map;
import java.util.zip.ZipFile;
import top.sywyar.pixivdownload.plugin.runtime.install.model.PluginPackageLimits;
import top.sywyar.pixivdownload.plugin.runtime.install.verify.ZipSafety;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;
import top.sywyar.pixivdownload.sdk.community.project.PluginProjectMarker;

/** 在工具私有工作区静态展开固定 GitHub 源码归档，绝不执行源码。 */
final class CommunitySource {
    static Object unpack(Path workspace, JsonNode input) throws Exception {
        Path archive = Path.of(input.get("file").textValue());
        var limits = PluginPackageLimits.defaults();
        if (!Files.isRegularFile(archive, LinkOption.NOFOLLOW_LINKS) || Files.size(archive) > limits.maxArchiveBytes()) {
            throw new ContractException("LIMIT_EXCEEDED", "/source/archive");
        }
        ZipSafety.assertNoSpecialFileEntries(archive);
        Path root = Files.createTempDirectory(workspace, "source-");
        String prefix = null;
        long total = 0;
        int count = 0;
        var names = new HashSet<String>();
        try (var zip = new ZipFile(archive.toFile())) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (++count > limits.maxEntries()) throw new ContractException("LIMIT_EXCEEDED", "/source/entries");
                String name = ZipSafety.requireUniqueEntryName(entry.getName(), names, limits);
                int slash = name.indexOf('/');
                if (slash < 1) throw new ContractException("PATH_MISMATCH", "/source/archive");
                String current = name.substring(0, slash + 1);
                if (prefix == null) prefix = current;
                if (!prefix.equals(current)) throw new ContractException("PATH_MISMATCH", "/source/archive");
                String relative = name.substring(slash + 1);
                if (relative.isEmpty()) continue;
                if (relative.endsWith("/")) relative = relative.substring(0, relative.length() - 1);
                if (java.util.Arrays.asList(relative.split("/")).contains(".git")) {
                    throw new ContractException("PATH_MISMATCH", "/source/.git");
                }
                Path target = CommunityPaths.resolve(root, relative, false, false);
                if (entry.isDirectory()) { Files.createDirectories(target); continue; }
                Files.createDirectories(target.getParent());
                long size = 0;
                try (InputStream stream = zip.getInputStream(entry); var out = Files.newOutputStream(target,
                        StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                    byte[] buffer = new byte[8192];
                    for (int n; (n = stream.read(buffer)) != -1;) {
                        size += n;
                        total += n;
                        if (size > limits.maxEntryUncompressedBytes() || total > limits.maxTotalUncompressedBytes()
                                || size >= 64 * 1024 && size > Math.max(1, entry.getCompressedSize()) * limits.maxCompressionRatio()) {
                            throw new ContractException("LIMIT_EXCEEDED", "/source/archive");
                        }
                        out.write(buffer, 0, n);
                    }
                }
            }
        }
        Path project = CommunityPaths.resolve(root, input.get("projectDir").textValue(), true, true);
        PluginProjectMarker.validate(project);
        return Map.of("sourceRoot", root.toString(), "entries", count, "uncompressedBytes", total);
    }
}
