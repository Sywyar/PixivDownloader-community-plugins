import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** 只读取固定 SDK 归档内的工具与合同资源，不执行归档代码。 */
public final class SdkArchive {
    private static final long MAX_FILE = 64L * 1024 * 1024;
    private static final long MAX_TOTAL = 64L * 1024 * 1024;

    private static boolean selected(String name) {
        return Set.of("tools/sdk-tools.jar", "tools/community-contract.json", "tools/build-model.mjs",
                "tools/community-model.gradle").contains(name) || name.startsWith("contracts/community/v1/");
    }

    private static void name(String value) throws IOException {
        if (value.length() > 512 || !value.matches("[A-Za-z0-9._/-]+") || value.startsWith("/")
                || Arrays.stream(value.split("/", -1)).anyMatch(s -> s.isEmpty() || s.equals(".") || s.equals(".."))) {
            throw new IOException("SDK_ARCHIVE_PATH_INVALID");
        }
    }

    private static String copy(ZipFile zip, ZipEntry entry, OutputStream output, long expected) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        long size = 0;
        try (var input = zip.getInputStream(entry)) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) != -1;) {
                size += count;
                if (size > expected || size > MAX_FILE) throw new IOException("SDK_ARCHIVE_SIZE_EXCEEDED");
                digest.update(buffer, 0, count);
                output.write(buffer, 0, count);
            }
        }
        if (size != expected) throw new IOException("SDK_ARCHIVE_SIZE_CHANGED");
        return HexFormat.of().formatHex(digest.digest());
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 && args.length != 4) throw new IOException("SDK_ARCHIVE_ARGUMENTS");
        boolean index = args[0].equals("index");
        if (index != (args.length == 2) || !index && !args[0].equals("extract")) throw new IOException("SDK_ARCHIVE_ARGUMENTS");
        var requested = new LinkedHashMap<String, String[]>();
        Path output = index ? null : Path.of(args[2]).toRealPath();
        if (!index) {
            if (Files.size(Path.of(args[3])) > 65536) throw new IOException("SDK_MANIFEST_INVALID");
            for (String line : Files.readAllLines(Path.of(args[3]), StandardCharsets.UTF_8)) {
                String[] row = line.split("\t", -1);
                if (row.length != 3 || !selected(row[0]) || !row[2].matches("[a-f0-9]{64}")) throw new IOException("SDK_MANIFEST_INVALID");
                name(row[0]);
                if (requested.put(row[0], row) != null || requested.size() > 256) throw new IOException("SDK_MANIFEST_INVALID");
            }
        }
        try (var zip = new ZipFile(args[1], StandardCharsets.UTF_8)) {
            var seen = new HashSet<String>();
            long total = 0;
            int entries = 0, resources = 0;
            var iterator = zip.entries();
            while (iterator.hasMoreElements()) {
                var entry = iterator.nextElement();
                if (++entries > 48000 || !seen.add(entry.getName())) throw new IOException("SDK_ARCHIVE_INVALID");
                if (entry.isDirectory() || !selected(entry.getName())) continue;
                name(entry.getName());
                long size = entry.getSize();
                if (++resources > 256 || size < 1 || size > MAX_FILE || (total += size) > MAX_TOTAL
                        || size > 65536 && size > Math.max(1, entry.getCompressedSize()) * 200) {
                    throw new IOException("SDK_ARCHIVE_SIZE_EXCEEDED");
                }
                if (index) {
                    System.out.println(entry.getName() + "\t" + size + "\t" + copy(zip, entry, OutputStream.nullOutputStream(), size));
                } else {
                    String[] row = requested.remove(entry.getName());
                    if (row == null || Long.parseLong(row[1]) != size) throw new IOException("SDK_ARCHIVE_FILES_CHANGED");
                    Path file = output.resolve(entry.getName()).normalize();
                    if (!file.startsWith(output)) throw new IOException("SDK_ARCHIVE_PATH_INVALID");
                    for (Path p = file; p != null; p = p.getParent()) {
                        if (Files.isSymbolicLink(p) || Files.exists(p, LinkOption.NOFOLLOW_LINKS)
                                && !p.toRealPath().equals(p.toAbsolutePath().normalize())) throw new IOException("SDK_CACHE_PATH_INVALID");
                    }
                    Files.createDirectories(file.getParent());
                    try (var stream = Files.newOutputStream(file, StandardOpenOption.CREATE_NEW)) {
                        if (!copy(zip, entry, stream, size).equals(row[2])) throw new IOException("SDK_RESOURCE_CHANGED");
                    }
                }
            }
            if (resources == 0 || !requested.isEmpty()) throw new IOException("SDK_ARCHIVE_FILES_CHANGED");
        }
    }
}
