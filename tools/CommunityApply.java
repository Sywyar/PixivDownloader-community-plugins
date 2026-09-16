import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import top.sywyar.pixivdownload.common.Utf8ConsoleStreams;
import top.sywyar.pixivdownload.plugin.signature.*;
import top.sywyar.pixivdownload.plugin.signature.internal.ed25519.Ed25519Signer;
import top.sywyar.pixivdownload.plugin.signature.internal.ed25519.Ed25519Verifier;
import top.sywyar.pixivdownload.plugin.signature.internal.envelope.EnvelopeV1Codec;
import top.sywyar.pixivdownload.plugin.signature.internal.trust.KeyParsing;
import top.sywyar.pixivdownload.sdk.community.format.*;
import top.sywyar.pixivdownload.sdk.community.format.CommunityValues.*;
import top.sywyar.pixivdownload.sdk.community.operation.*;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;
import top.sywyar.pixivdownload.sdk.community.review.*;
import top.sywyar.pixivdownload.sdk.community.directory.*;

/** 受保护执行器的薄适配：状态归约、字节合同和签名编码全部复用固定 SDK。 */
public final class CommunityApply {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();
    private final Path workspace;
    private final JsonNode input;
    private final Map<String, Evidence> records = new HashMap<>();

    private CommunityApply(Path workspace) throws Exception {
        this.workspace = workspace;
        try (var stream = Files.newInputStream(workspace.resolve("apply-input.json"))) {
            input = CommunityJson.strictTree(stream.readNBytes(MAX_BYTES + 1), MAX_BYTES);
        }
        long total = 0;
        for (var node : input.withArray("evidence")) {
            var ref = JSON.treeToValue(node, Reference.class);
            if (ref.size() < 0 || (total += ref.size()) > MAX_BYTES || records.containsKey(ref.path())) {
                throw new IllegalArgumentException("APPLY_EVIDENCE_BUDGET");
            }
            Path file = CommunityPaths.resolve(workspace, ref.path(), false, true);
            try (var stream = Files.newInputStream(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                records.put(ref.path(), new Evidence(ref, stream.readNBytes((int) ref.size() + 1)));
            }
        }
    }

    private Evidence evidence(JsonNode node) throws Exception {
        return CommunityValues.requireEvidence(JSON.treeToValue(node, Reference.class), records);
    }
    private CommunityJson.Document document(String field, CommunityJson.Kind kind) throws Exception {
        return input.hasNonNull(field) ? CommunityJson.parse(kind, evidence(input.get(field)).bytes()) : null;
    }
    private Map<String, String> operation() throws Exception {
        var authority = authority();
        var recovery = new ArrayList<Reference>();
        for (var ref : input.withArray("recoveryEvidence")) recovery.add(evidence(ref).reference());
        var request = evidence(input.get("request"));
        var context = new OperationContext(request, authority, recovery.isEmpty() ? null : recovery,
                input.get("appliedAt").textValue(), records, Map.of());
        OperationResult result;
        var outputs = new LinkedHashMap<String, String>();
        switch (input.get("operation").textValue()) {
            case "KEY_ROTATION" -> result = PublisherKeyRotation.apply(context, document("publisher", CommunityJson.Kind.PUBLISHER)).result();
            case "YANK", "UNYANK", "REVOKE" -> {
                var restrictions = new ArrayList<VersionRevocations.Restriction>();
                for (var node : input.withArray("restrictions")) restrictions.add(JSON.treeToValue(node, VersionRevocations.Restriction.class));
                var current = VersionRevocations.read(evidence(input.get("revocations")), restrictions);
                var value = VersionStatus.apply(context, document("binding", CommunityJson.Kind.BINDING), document("publisher", CommunityJson.Kind.PUBLISHER),
                        JSON.treeToValue(input.get("state"), VersionState.class), current, input.get("sequence").longValue(), input.get("nextUpdate").textValue());
                result = value.operation().result();
                outputs.put("revocations/restrictions.json", encode(CommunityJson.encode(value.revocations().restrictions())));
            }
            case "OWNERSHIP_TRANSFER" -> {
                result = OwnershipTransfer.apply(context, document("binding", CommunityJson.Kind.BINDING), document("targetPublisher", CommunityJson.Kind.PUBLISHER),
                        input.path("targetLogin").asText(null), transferApprovals()).result();
            }
            default -> throw new IllegalArgumentException("APPLY_OPERATION_INVALID");
        }
        result.evidence().forEach((path, record) -> outputs.put(path, encode(record.bytes())));
        result.writes().forEach((path, ref) -> outputs.put(path, encode(CommunityValues.requireEvidence(ref, result.evidence()).bytes())));
        var audit = OperationAudit.read(result.audit());
        outputs.put("audits/" + audit.requestId() + ".json", encode(result.audit().bytes()));
        return outputs;
    }

    private List<TransferApproval.Input> transferApprovals() throws Exception {
        var approvals = new ArrayList<TransferApproval.Input>();
        for (var node : input.withArray("approvals")) {
            var record = evidence(node.get("reference"));
            approvals.add(new TransferApproval.Input(CommunityJson.parse(CommunityJson.Kind.APPROVAL, record.bytes()),
                    record.reference().path(), JSON.treeToValue(node.get("pr"), CommunityPr.class),
                    JSON.treeToValue(node.get("author"), Account.class), true));
        }
        return approvals;
    }

    private Object transferReady() throws Exception {
        var record = evidence(input.get("request"));
        var request = OwnershipTransferRequest.read(CommunityJson.parse(CommunityJson.Kind.TRANSFER, record.bytes()), record.reference().path());
        try { TransferApproval.requireApprovals(transferApprovals(), request, authority()); }
        catch (ContractException error) {
            if (!error.code().equals("APPROVAL_REQUIRED")) throw error;
            return Map.of("ready", false);
        }
        return Map.of("ready", true);
    }

    private Object confirmOperation() throws Exception {
        var record = evidence(input.get("audit"));
        var document = CommunityJson.parse(CommunityJson.Kind.AUDIT, record.bytes());
        var audit = OperationAudit.read(document);
        audit.confirmPreparedMerge(document, JSON.treeToValue(input.get("pr"), CommunityPr.class), record.reference(),
                JSON.convertValue(input.get("generatedParents"), new com.fasterxml.jackson.core.type.TypeReference<List<String>>() { }),
                JSON.convertValue(input.get("mergeParents"), new com.fasterxml.jackson.core.type.TypeReference<List<String>>() { }));
        return Map.of("verified", true);
    }

    private OperationAuthority authority() throws Exception {
        var value = input.get("authority");
        var representations = new ArrayList<OperationAuthority.Representation>();
        for (var row : value.withArray("representations")) representations.add(new OperationAuthority.Representation(
                JSON.treeToValue(row.get("subject"), Owner.class), row.get("personAccountId").textValue(), evidence(row.get("evidence"))));
        var approval = value.get("approval");
        var signed = value.get("signedStatus");
        return new OperationAuthority(JSON.treeToValue(value.get("proposalPr"), CommunityPr.class),
                JSON.treeToValue(value.get("actualAuthor"), Account.class), representations,
                approval == null || approval.isNull() ? null : new OperationAuthority.Approval(approval.get("requestId").textValue(), approval.get("headSha").textValue(),
                        strings(approval.get("reviewerAccountIds")), approval.get("recoveryApproved").booleanValue(), evidence(approval.get("evidence"))),
                strings(value.get("authorizedReviewers")), signed == null || signed.isNull() ? null
                    : new OperationAuthority.SignedStatus(signed.get("requestId").textValue(), signed.get("headSha").textValue(), evidence(signed.get("evidence"))));
    }

    private static java.util.Set<String> strings(JsonNode value) {
        var result = new java.util.HashSet<String>();
        for (var item : value) if (!item.isTextual() || !result.add(item.textValue())) throw new IllegalArgumentException("APPLY_IDENTITIES_INVALID");
        return result;
    }

    private Object publication() throws Exception {
        var key = JSON.treeToValue(input.get("communityKey"), TrustedPluginKey.class);
        var verifier = new PluginSupplyChainVerifier(PluginTrustStores.community(List.of(key)));
        var facts = JSON.treeToValue(input.get("facts"), VersionReview.Facts.class);
        var publication = new PublishedVersion.Publication(evidence(input.get("submission")), evidence(input.get("review")),
                document("binding", CommunityJson.Kind.BINDING), evidence(input.get("publisher")), facts,
                CommunityPaths.resolve(workspace, input.get("packageFile").textValue(), false, true),
                input.get("repositoryId").textValue(), verifier, JSON.treeToValue(input.get("signature"), SignatureMetadata.class),
                input.get("appliedAt").textValue(), records, MAX_BYTES, MAX_BYTES);
        return Map.of("bytes", encode(PublishedVersion.prepare(publication, Map.of(), document("previousVersion", CommunityJson.Kind.PUBLISHED)).document().bytes()));
    }

    private Object confirmPublication() throws Exception {
        var key = JSON.treeToValue(input.get("communityKey"), TrustedPluginKey.class);
        var verifier = new PluginSupplyChainVerifier(PluginTrustStores.community(List.of(key)));
        var published = PublishedVersion.read(document("published", CommunityJson.Kind.PUBLISHED));
        published.verifyHistory(CommunityPaths.resolve(workspace, input.get("packageFile").textValue(), false, true),
                document("publisher", CommunityJson.Kind.PUBLISHER), verifier, input.get("repositoryId").textValue(), records,
                JSON.treeToValue(input.get("merge"), PublishedVersion.PreparedMerge.class));
        return Map.of("verified", true);
    }

    private Object sign() throws Exception {
        var key = JSON.treeToValue(input.get("communityKey"), TrustedPluginKey.class);
        PluginTrustStores.community(List.of(key));
        if (key.state() != TrustedPluginKey.State.ACTIVE) throw new IllegalArgumentException("SIGNING_KEY_NOT_ACTIVE");
        String repositoryId = input.get("repositoryId").textValue();
        byte[] message;
        if (input.get("kind").textValue().equals("package")) {
            message = EnvelopeV1Codec.communityPackageMessage("Ed25519", key.keyId(), repositoryId,
                    input.get("pluginId").textValue(), input.get("version").textValue(), input.get("size").longValue(),
                    HexFormat.of().parseHex(input.get("sha256").textValue()), "SOURCE_REVIEWED", input.get("sourceCommit").textValue(),
                    HexFormat.of().parseHex(input.get("reviewSha256").textValue()));
        } else {
            byte[] bytes = evidence(input.get("document")).bytes();
            byte[] digest = HexFormat.of().parseHex(CommunityJson.sha256(bytes));
            message = switch (input.get("kind").textValue()) {
                case "manifest" -> EnvelopeV1Codec.manifestMessage(repositoryId, bytes.length, digest);
                case "revocations" -> EnvelopeV1Codec.pluginRevocationsMessage(repositoryId, input.get("sequence").longValue(), bytes.length, digest);
                case "directory" -> EnvelopeV1Codec.communityDirectoryMessage(repositoryId, input.get("sequence").longValue(), bytes.length, digest);
                default -> throw new IllegalArgumentException("SIGNING_DOMAIN_INVALID");
            };
        }
        byte[] secret = System.in.readNBytes(16385);
        try {
            if (secret.length > 16384) throw new IllegalArgumentException("SIGNING_KEY_SIZE");
            byte[] signature = Ed25519Signer.sign(KeyParsing.ed25519PrivateKey(new String(secret, StandardCharsets.UTF_8)), message);
            if (!Ed25519Verifier.verify(key.publicKeySpkiBase64(), message, signature)) throw new IllegalArgumentException("KEY_PAIR_MISMATCH");
            return new SignatureMetadata(1, "Ed25519", key.keyId(), encode(signature));
        } finally { java.util.Arrays.fill(secret, (byte) 0); }
    }

    private static String encode(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }

    private Object directory() throws Exception {
        var entries = new ArrayList<DirectoryEntry>();
        for (var row : input.withArray("entries")) entries.add(JSON.treeToValue(row, DirectoryEntry.class));
        var value = DirectoryGeneration.generate(input.get("repositoryId").textValue(), input.get("sequence").longValue(),
                input.get("appliedAt").textValue(), entries);
        var result = new LinkedHashMap<String, String>();
        result.put("directory.json", encode(value.root().bytes()));
        value.shards().forEach((digest, document) -> result.put("shards/" + digest + ".json", encode(document.bytes())));
        return result;
    }

    private Object revocations() throws Exception {
        var restrictions = new ArrayList<VersionRevocations.Restriction>();
        for (var row : input.withArray("restrictions")) {
            var restriction = JSON.treeToValue(row, VersionRevocations.Restriction.class);
            CommunityValues.requireEvidence(restriction.decisionRef(), records);
            restrictions.add(restriction);
        }
        var result = VersionRevocations.generate(input.get("repositoryId").textValue(), input.get("sequence").longValue(),
                input.get("appliedAt").textValue(), input.get("nextUpdate").textValue(), restrictions);
        return Map.of("bytes", encode(result.archive().bytes()));
    }

    private Object verifyGeneration() throws Exception {
        var key = JSON.treeToValue(input.get("communityKey"), TrustedPluginKey.class);
        var verifier = new PluginSupplyChainVerifier(PluginTrustStores.community(List.of(key)));
        String repositoryId = input.get("repositoryId").textValue();
        var shards = new HashMap<String, CommunityJson.Document>();
        for (var row : input.withArray("shards")) {
            var record = evidence(row);
            shards.put(record.reference().sha256(), CommunityJson.parse(CommunityJson.Kind.DIRECTORY_SHARD, record.bytes()));
        }
        var directory = new DirectoryGeneration.Candidate(document("directory", CommunityJson.Kind.DIRECTORY_ROOT), shards);
        DirectoryGeneration.verify(directory, java.net.URI.create(input.get("rootUrl").textValue()), repositoryId,
                JSON.treeToValue(input.get("directorySignature"), SignatureMetadata.class), verifier);
        var catalog = evidence(input.get("catalog"));
        var manifest = verifier.verifyManifest(new ManifestVerificationRequest(catalog.bytes(), repositoryId,
                JSON.treeToValue(input.get("catalogSignature"), SignatureMetadata.class), VerificationPolicy.customRepository()));
        var revocations = evidence(input.get("revocations"));
        var revoked = verifier.verifyPluginRevocations(new PluginRevocationsVerificationRequest(revocations.bytes(), repositoryId,
                CommunityJson.strictTree(revocations.bytes(), MAX_BYTES).get("sequence").longValue(),
                JSON.treeToValue(input.get("revocationSignature"), SignatureMetadata.class), VerificationPolicy.customRepository()));
        if (manifest.status() != VerificationStatus.VERIFIED || revoked.status() != VerificationStatus.VERIFIED) {
            throw new IllegalArgumentException("GENERATION_SIGNATURE_INVALID");
        }
        return Map.of("verified", true);
    }

    public static void main(String[] args) throws Exception {
        Utf8ConsoleStreams.install();
        if (args.length != 1) throw new IllegalArgumentException("APPLY_ARGUMENTS");
        var tool = new CommunityApply(Path.of(args[0]));
        Object result = switch (tool.input.get("command").textValue()) {
            case "operation" -> tool.operation();
            case "transfer-ready" -> tool.transferReady();
            case "publication" -> tool.publication();
            case "confirm-publication" -> tool.confirmPublication();
            case "confirm-operation" -> tool.confirmOperation();
            case "sign" -> tool.sign();
            case "directory" -> tool.directory();
            case "revocations" -> tool.revocations();
            case "verify-generation" -> tool.verifyGeneration();
            default -> throw new IllegalArgumentException("APPLY_COMMAND");
        };
        byte[] bytes = CommunityJson.encode(result);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("APPLY_OUTPUT_BUDGET");
        System.out.println(new String(bytes, StandardCharsets.UTF_8));
    }
}
