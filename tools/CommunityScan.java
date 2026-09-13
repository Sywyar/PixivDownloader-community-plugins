import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import top.sywyar.pixivdownload.common.Utf8ConsoleStreams;
import top.sywyar.pixivdownload.plugin.runtime.install.model.PluginPackageLimits;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Evidence;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Reference;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;
import top.sywyar.pixivdownload.sdk.community.scan.PluginRiskScanner;
import top.sywyar.pixivdownload.sdk.community.scan.PluginScanEvidence;

/** 固定 SDK 的静态扫描适配器；不把投稿 JAR 放入 JVM classpath。 */
public final class CommunityScan {
    private static final int MAXIMUM = 32 * 1024 * 1024;

    public static void main(String[] args) throws Exception {
        Utf8ConsoleStreams.install();
        if (args.length != 2) throw new IllegalArgumentException("COMMUNITY_SCAN_ARGUMENTS");
        Path workspace = Path.of(args[0]);
        JsonNode input;
        try (var stream = Files.newInputStream(Path.of(args[1]), LinkOption.NOFOLLOW_LINKS)) {
            input = CommunityJson.strictTree(stream.readNBytes(MAXIMUM + 1), MAXIMUM);
        }
        var current = scan(input.get("current"), input.get("execution"));
        var previous = input.hasNonNull("previous") ? scan(input.get("previous"), input.get("execution")) : null;
        var report = encoded(current.report());
        var sbom = PluginScanEvidence.sbom(current, MAXIMUM);
        var difference = PluginScanEvidence.difference(current.report(), previous == null ? null : previous.report(), MAXIMUM);
        var evidence = new ArrayList<Evidence>(current.evidence());
        if (previous != null) evidence.addAll(previous.evidence());
        evidence.addAll(List.of(report, sbom, difference));
        long total = 0;
        for (var value : evidence) {
            total += value.reference().size();
            if (total > MAXIMUM) throw new ContractException("LIMIT_EXCEEDED", "/scanEvidence");
            Path file = CommunityPaths.resolve(workspace, value.reference().path(), false, false);
            Files.createDirectories(file.getParent());
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) value.reference().verify(workspace);
            else Files.write(file, value.bytes(), StandardOpenOption.CREATE_NEW);
        }
        System.out.println(new String(CommunityJson.encode(Map.of("riskReportRef", report.reference(),
                "sbomRef", sbom.reference(), "riskDifferenceRef", difference.reference(),
                "evidence", evidence.stream().map(Evidence::reference).toList())), java.nio.charset.StandardCharsets.UTF_8));
    }

    private static PluginRiskScanner.Result scan(JsonNode input, JsonNode execution) throws Exception {
        var classes = new HashSet<String>();
        for (JsonNode entry : input.get("compiledClasses")) {
            String digest = entry.get("sha256").textValue();
            if (digest == null || !digest.matches("[a-f0-9]{64}")) throw new ContractException("SCHEMA_INVALID", "/compiledClasses");
            classes.add(digest);
        }
        var run = new PluginRiskScanner.Execution(execution.get("runId").textValue(), execution.get("runAttempt").longValue(),
                execution.get("headSha").textValue(), input.get("sourceCommit").textValue());
        return PluginRiskScanner.scan(Path.of(input.get("artifact").textValue()), input.get("sha256").textValue(),
                run, PluginPackageLimits.defaults(), MAXIMUM, classes);
    }

    private static Evidence encoded(Object value) {
        byte[] bytes = CommunityJson.encode(value);
        return new Evidence(Reference.of("reviews/evidence/" + CommunityJson.sha256(bytes) + ".json", bytes), bytes);
    }
}
