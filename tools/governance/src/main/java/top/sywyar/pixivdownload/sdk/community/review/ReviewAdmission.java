package top.sywyar.pixivdownload.sdk.community.review;

import top.sywyar.pixivdownload.plugin.runtime.descriptor.PluginRiskDeclaration;
import top.sywyar.pixivdownload.sdk.community.format.CommunityPr;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Evidence;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.Reference;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;
import top.sywyar.pixivdownload.sdk.community.operation.OperationAudit;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** 归约已取得的平台事实，输出门禁与标签投影；不发布检查、评论或文件。 */
public final class ReviewAdmission {
    private ReviewAdmission() { }
    public enum Conclusion { SUCCESS, FAILURE, PENDING, SKIPPED, NEUTRAL, CANCELLED }
    public enum PrState { OPEN, CLOSED, MERGED }
    public enum ApplyState { WAITING, FAILED, APPLIED }
    public enum Flow { NONE, READY, CLOSED, AWAITING_APPLY, APPLY_FAILED, COMPLETED }
    public enum Authorization { HUMAN_REVIEW, SIGNED_OWNER, POLICY_RENEWAL }
    /** 平台核对机器人身份、唯一请求文件与当前主线后提供，不能从 PR 自报授权构造。 */
    public record Renewal(CommunityPr pr, String inputSha256, Evidence request, Evidence generation, Evidence revocations) { }
    public record Scan(String runId, long runAttempt, String scannerVersion, String rulesSha256, Conclusion conclusion) { }
    public record Apply(ApplyState state, String expectedGenerationSha256, String readbackGenerationSha256) { }
    /** version 为空表示已由输入校验确认的非版本操作，此时扫描明确不适用。 */
    public record Snapshot(String repositoryId, CommunityPr pr, ReviewDecision.Version version, String inputSha256,
                            String bindingSha256, String policySha256, PrState state, boolean draft, Scan scan, Apply apply) { }
    /** 发布来源与这些绑定均须来自原生检查元数据，不能按显示名称猜测来源。 */
    public record Validation(Conclusion conclusion, String publisherId, String headSha, String baseSha, String inputSha256,
                              String bindingSha256, String policySha256) {
        boolean matches(Snapshot snapshot, String expectedPublisherId) {
            return conclusion == Conclusion.SUCCESS && Objects.equals(publisherId, expectedPublisherId)
                    && Objects.equals(headSha, snapshot.pr.headSha()) && Objects.equals(baseSha, snapshot.pr.baseSha())
                    && Objects.equals(inputSha256, snapshot.inputSha256)
                    && Objects.equals(bindingSha256, snapshot.bindingSha256) && Objects.equals(policySha256, snapshot.policySha256);
        }
    }
    public record Result(Snapshot snapshot, Reference reportRef, List<Reference> decisionRefs,
                         boolean validationPassed, boolean riskPassed, HumanReviews.Result human,
                         boolean scanIncomplete, boolean manualScanAccepted, List<String> blockingFindingIds,
                         Flow flow, Set<String> labels, Authorization authorization) {
        public Result {
            decisionRefs = List.copyOf(decisionRefs);
            blockingFindingIds = List.copyOf(blockingFindingIds); labels = Set.copyOf(labels);
        }
        public boolean authorizationPassed() {
            return human.status() != HumanReviews.Status.CHANGES_REQUESTED
                    && (human.passed() || authorization == Authorization.SIGNED_OWNER || authorization == Authorization.POLICY_RENEWAL);
        }
    }

    public static Result evaluate(Snapshot before, Snapshot after, Validation validation, String expectedPublisherId,
                                  ReviewPolicy policy, List<HumanReviews.NativeReview> reviews,
                                  List<ReviewDecision.Input> decisionInputs, Evidence reportEvidence,
                                  int maximumReportBytes, PluginRiskDeclaration declaration, Map<String, Evidence> evidence) {
        if (!before.equals(after)) throw new ContractException("REVIEW_MISMATCH", "/current");
        Snapshot snapshot = after;
        snapshot.pr.validate();
        scalar("repositoryId", snapshot.repositoryId);
        scalar("sha256", snapshot.inputSha256);
        scalar("sha256", snapshot.bindingSha256);
        scalar("sha256", snapshot.policySha256);
        scalar("id", expectedPublisherId);
        if (snapshot.state == null || validation.conclusion == null) throw new ContractException("REVIEW_MISMATCH", "/current");
        if (snapshot.version != null) {
            scalar("sha256", snapshot.version.submissionSha256());
            scalar("commit", snapshot.version.sourceCommit());
            scalar("sha256", snapshot.version.packageSha256());
        }
        boolean validated = validation.matches(snapshot, expectedPublisherId);
        RiskReport report = null;
        if (snapshot.version != null) {
            if (reportEvidence == null || snapshot.scan == null) throw new ContractException("REVIEW_MISMATCH", "/riskScan/reportRef");
            report = RiskReport.read(reportEvidence, maximumReportBytes);
            Scan scan = snapshot.scan;
            if (!report.headSha().equals(snapshot.pr.headSha()) || !report.sourceCommit().equals(snapshot.version.sourceCommit())
                    || !report.packageSha256().equals(snapshot.version.packageSha256()) || !report.runId().equals(scan.runId)
                    || report.runAttempt() != scan.runAttempt || !report.scannerVersion().equals(scan.scannerVersion)
                    || !report.rulesSha256().equals(scan.rulesSha256)
                    || report.status() == RiskReport.Status.COMPLETE && scan.conclusion != Conclusion.SUCCESS) {
                throw new ContractException("REVIEW_MISMATCH", "/riskScan");
            }
            report.validate(declaration, evidence);
        } else if (snapshot.scan != null || reportEvidence != null) {
            throw new ContractException("REVIEW_MISMATCH", "/riskScan");
        }
        var decisions = ReviewDecisions.evaluate(snapshot.repositoryId, snapshot.pr, snapshot.version, report,
                reportEvidence == null ? null : reportEvidence.reference(), policy, decisionInputs);
        boolean incomplete = report != null && report.status() == RiskReport.Status.INCOMPLETE;
        List<String> blockers = report == null ? List.of() : report.findings().stream()
                .filter(f -> !decisions.falsePositives().contains(f.findingId())).map(RiskReport.Finding::findingId).sorted().toList();
        boolean riskPassed = blockers.isEmpty() && (!incomplete || decisions.manualScanAccepted());
        var human = HumanReviews.evaluate(snapshot.pr, policy, reviews, decisions);
        Flow flow = flow(snapshot, validated && riskPassed && human.passed());
        var labels = new HashSet<String>();
        labels.add(validation.conclusion == Conclusion.PENDING ? "ci:running" : validated && riskPassed ? "ci:passed" : "ci:blocked");
        labels.add(switch (human.status()) {
            case PENDING -> "review:pending";
            case APPROVED -> "review:approved";
            case SELF_APPROVED -> "review:self-approved";
            case CHANGES_REQUESTED -> "review:changes-requested";
        });
        if (incomplete) labels.add("scan:incomplete");
        if (decisions.manualScanAccepted()) labels.add("scan:manual-accepted");
        if (!decisions.falsePositives().isEmpty()) labels.add("scan:false-positive");
        switch (flow) {
            case READY -> labels.add("state:ready");
            case AWAITING_APPLY -> labels.add("state:awaiting-apply");
            case APPLY_FAILED -> labels.add("state:apply-failed");
            case COMPLETED -> labels.add("state:completed");
            case NONE, CLOSED -> { }
        }
        return new Result(snapshot, reportEvidence == null ? null : reportEvidence.reference(), decisions.references(),
                validated, riskPassed, human, incomplete, decisions.manualScanAccepted(), blockers, flow, labels, Authorization.HUMAN_REVIEW);
    }

    /** 仅接受操作归约器对当前受保护状态重新验签的结果，不能读取 PR 自报审计代替验证。 */
    public static Result authorizeStatus(Result result, CommunityJson.Document verifiedAudit) {
        var audit = OperationAudit.read(verifiedAudit);
        if (result.snapshot.version != null || !"SIGNED_OWNER".equals(audit.authorization())
                || !"PREPARED".equals(audit.result()) || !audit.prEvidence().equals(List.of(result.snapshot.pr))
                || !audit.actorAccountId().equals(result.snapshot.pr.authorAccountId())) {
            throw new ContractException("REVIEW_MISMATCH", "/authorization");
        }
        return authorized(result, Authorization.SIGNED_OWNER, "authorization:signed-owner");
    }

    /** 续签只能延续当前整代的时效，实际生成器仍须证明业务内容及人工审核证据未变。 */
    public static Result authorizeRenewal(Result result, Renewal renewal) {
        if (renewal == null || result.snapshot.version != null || !result.snapshot.pr.equals(renewal.pr)
                || !result.snapshot.inputSha256.equals(renewal.inputSha256)
                || !renewal.pr.githubRepositoryId().equals(renewal.pr.headRepositoryId())
                || renewal.request == null || renewal.generation == null || renewal.revocations == null) {
            throw new ContractException("REVIEW_MISMATCH", "/renewal");
        }
        var requestBytes = renewal.request.bytes();
        var generationBytes = renewal.generation.bytes();
        var revocationBytes = renewal.revocations.bytes();
        var request = CommunityJson.strictTree(requestBytes, requestBytes.length);
        var generation = CommunityJson.strictTree(generationBytes, generationBytes.length);
        var revocations = CommunityJson.strictTree(revocationBytes, revocationBytes.length);
        var fields = new HashSet<String>();
        request.fieldNames().forEachRemaining(fields::add);
        if (!fields.equals(Set.of("schemaVersion", "operation", "generation", "generationSha256", "revocationsSha256", "nextUpdate", "baseSha"))
                || !request.path("schemaVersion").isIntegralNumber() || !request.path("schemaVersion").canConvertToInt()
                || request.path("schemaVersion").intValue() != 1
                || !"RENEWAL".equals(request.path("operation").textValue())
                || !renewal.pr.baseSha().equals(request.path("baseSha").textValue())
                || !request.path("generation").isIntegralNumber() || !request.path("generation").canConvertToLong()
                || request.path("generation").longValue() < 1 || !request.path("generation").equals(generation.path("sequence"))
                || !renewal.generation.reference().sha256().equals(request.path("generationSha256").textValue())
                || !renewal.revocations.reference().sha256().equals(request.path("revocationsSha256").textValue())
                || !renewal.revocations.reference().sha256().equals(generation.path("revocations").path("sha256").textValue())
                || !generation.path("revocations").path("size").isIntegralNumber()
                || !generation.path("revocations").path("size").canConvertToLong()
                || generation.path("revocations").path("size").longValue() != revocationBytes.length
                || !request.path("nextUpdate").isTextual() || !request.path("nextUpdate").equals(revocations.path("nextUpdate"))
                || !result.snapshot.repositoryId.equals(revocations.path("repositoryId").textValue())) {
            throw new ContractException("REVIEW_MISMATCH", "/renewal");
        }
        scalar("externalTime", request.path("nextUpdate").textValue());
        return authorized(result, Authorization.POLICY_RENEWAL, "authorization:policy-renewal");
    }

    private static Result authorized(Result result, Authorization authorization, String label) {
        boolean authorized = result.human.status() != HumanReviews.Status.CHANGES_REQUESTED;
        var flow = flow(result.snapshot, result.validationPassed && result.riskPassed && authorized);
        var labels = new HashSet<>(result.labels);
        labels.remove("review:pending");
        labels.remove("state:ready");
        labels.add(label);
        if (flow == Flow.READY) labels.add("state:ready");
        return new Result(result.snapshot, result.reportRef, result.decisionRefs, result.validationPassed, result.riskPassed,
                result.human, result.scanIncomplete, result.manualScanAccepted, result.blockingFindingIds, flow, labels, authorization);
    }

    private static Flow flow(Snapshot snapshot, boolean ready) {
        if (snapshot.state == PrState.CLOSED) return Flow.CLOSED;
        if (snapshot.state == PrState.OPEN) return !snapshot.draft && ready ? Flow.READY : Flow.NONE;
        if (snapshot.pr.mergeSha() == null) throw new ContractException("REVIEW_MISMATCH", "/pr/mergeSha");
        Apply apply = snapshot.apply;
        if (apply == null || apply.state == ApplyState.WAITING) return Flow.AWAITING_APPLY;
        if (apply.state != ApplyState.APPLIED) return Flow.APPLY_FAILED;
        if (apply.expectedGenerationSha256 == null || !apply.expectedGenerationSha256.equals(apply.readbackGenerationSha256)) {
            return Flow.APPLY_FAILED;
        }
        scalar("sha256", apply.expectedGenerationSha256);
        return Flow.COMPLETED;
    }

    private static void scalar(String definition, String value) {
        byte[] bytes = CommunityJson.encode(value);
        CommunityJson.validateStructure(definition, CommunityJson.strictTree(bytes, bytes.length));
    }
}
