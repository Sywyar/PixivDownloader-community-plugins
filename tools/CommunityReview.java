import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import top.sywyar.pixivdownload.common.Utf8ConsoleStreams;
import top.sywyar.pixivdownload.plugin.runtime.descriptor.PluginRiskDeclaration;
import top.sywyar.pixivdownload.sdk.community.format.CommunityBundle;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Evidence;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Reference;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;
import top.sywyar.pixivdownload.sdk.community.review.HumanReviews;
import top.sywyar.pixivdownload.sdk.community.review.ReviewAdmission;
import top.sywyar.pixivdownload.sdk.community.review.ReviewDecision;
import top.sywyar.pixivdownload.sdk.community.review.ReviewPolicy;

/** 将已核实的平台事实交给社区治理实现；数据格式与技术验证使用固定基础合同。 */
public final class CommunityReview {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    public record Dismissal(String actorAccountId, String reason, Reference evidence) { }
    public record Review(String id, String githubRepositoryId, long prNumber, CommunityValues.Account reviewer,
                         String headSha, HumanReviews.NativeState state, String submittedAt, Reference evidence, Dismissal dismissal) { }
    public record Decision(Reference evidence, ReviewDecision.Execution execution) { }
    public record Renewal(Reference request, Reference generation, Reference revocations) { }
    public record Input(ReviewAdmission.Snapshot before, ReviewAdmission.Snapshot after, ReviewAdmission.Validation validation,
                        String publisherId, ReviewPolicy policy, List<Review> reviews, List<Decision> decisions,
                        Reference report, PluginRiskDeclaration declaration, List<Reference> evidence, Reference statusAudit,
                        Renewal renewal) { }

    public static void main(String[] args) throws Exception {
        Utf8ConsoleStreams.install();
        if (args.length != 3) throw new IllegalArgumentException("COMMUNITY_ARGUMENTS");
        Path workspace = Path.of(args[0]);
        CommunityBundle.verifyCopy(workspace.resolve("contracts/community/v1"));
        com.fasterxml.jackson.databind.JsonNode identity;
        try (var stream = CommunityReview.class.getResourceAsStream("/META-INF/community-tools.json")) {
            if (stream == null) throw new IllegalArgumentException("COMMUNITY_IDENTITY_MISSING");
            identity = CommunityJson.strictTree(stream.readNBytes(4097), 4096);
        }
        if (!identity.path("sourceSha256").asText().equals(args[1])) {
            throw new IllegalArgumentException("COMMUNITY_SOURCE_MISMATCH");
        }
        if (args[2].equals("verify")) {
            System.out.println(identity);
            return;
        }
        if (args[2].equals("artifact")) {
            // 仅读取唯一的数据文件；不把 artifact 路径解压到文件系统。
            try (var zip = new java.util.zip.ZipFile(workspace.resolve("artifact.zip").toFile())) {
                if (zip.size() != 1) throw new IllegalArgumentException("DECISION_ARTIFACT_ENTRIES");
                var entry = zip.entries().nextElement();
                if (entry.isDirectory() || !entry.getName().equals("decision.json")) {
                    throw new IllegalArgumentException("DECISION_ARTIFACT_PATH");
                }
                byte[] decision;
                try (var stream = zip.getInputStream(entry)) { decision = stream.readNBytes(65537); }
                CommunityJson.parse(CommunityJson.Kind.DECISION, decision);
                System.out.println("\"" + java.util.Base64.getEncoder().encodeToString(decision) + "\"");
            }
            return;
        }
        if (!args[2].equals("review")) throw new IllegalArgumentException("COMMUNITY_COMMAND");
        byte[] bytes;
        try (var stream = Files.newInputStream(workspace.resolve("input.json"))) { bytes = stream.readNBytes(MAX_BYTES + 1); }
        Input input = new ObjectMapper().treeToValue(CommunityJson.strictTree(bytes, MAX_BYTES), Input.class);
        var evidence = new HashMap<String, Evidence>();
        long total = 0;
        for (var reference : input.evidence) {
            total += reference.size();
            if (reference.size() < 0 || total > MAX_BYTES || evidence.containsKey(reference.path())) {
                throw new IllegalArgumentException("COMMUNITY_EVIDENCE_BUDGET");
            }
            Path file = CommunityPaths.resolve(workspace, reference.path(), false, true);
            try (var stream = Files.newInputStream(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                evidence.put(reference.path(), new Evidence(reference, stream.readNBytes((int) reference.size() + 1)));
            }
        }
        var reviews = new ArrayList<HumanReviews.NativeReview>();
        for (var review : input.reviews) {
            var dismissal = review.dismissal;
            reviews.add(new HumanReviews.NativeReview(review.id, review.githubRepositoryId, review.prNumber, review.reviewer,
                    review.headSha, review.state, review.submittedAt, CommunityValues.requireEvidence(review.evidence, evidence),
                    dismissal == null ? null : new HumanReviews.Dismissal(dismissal.actorAccountId, dismissal.reason,
                            CommunityValues.requireEvidence(dismissal.evidence, evidence))));
        }
        var decisions = new ArrayList<ReviewDecision.Input>();
        for (var decision : input.decisions) {
            var archive = CommunityValues.requireEvidence(decision.evidence, evidence);
            decisions.add(new ReviewDecision.Input(CommunityJson.parse(CommunityJson.Kind.DECISION, archive.bytes()), archive, decision.execution));
        }
        var result = ReviewAdmission.evaluate(input.before, input.after, input.validation, input.publisherId, input.policy,
                reviews, decisions, input.report == null ? null : CommunityValues.requireEvidence(input.report, evidence),
                MAX_BYTES, input.declaration, evidence);
        if (input.statusAudit != null) result = ReviewAdmission.authorizeStatus(result,
                CommunityJson.parse(CommunityJson.Kind.AUDIT, CommunityValues.requireEvidence(input.statusAudit, evidence).bytes()));
        if (input.renewal != null) result = ReviewAdmission.authorizeRenewal(result,
                new ReviewAdmission.Renewal(input.after.pr(), input.after.inputSha256(),
                        CommunityValues.requireEvidence(input.renewal.request, evidence),
                        CommunityValues.requireEvidence(input.renewal.generation, evidence),
                        CommunityValues.requireEvidence(input.renewal.revocations, evidence)));
        System.out.println(new String(CommunityJson.encode(result), java.nio.charset.StandardCharsets.UTF_8));
    }
}
