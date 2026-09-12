import com.fasterxml.jackson.databind.JsonNode;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import top.sywyar.pixivdownload.common.Utf8ConsoleStreams;
import top.sywyar.pixivdownload.plugin.runtime.install.model.PluginPackageLimits;
import top.sywyar.pixivdownload.plugin.runtime.install.verify.PluginPackageReader;
import top.sywyar.pixivdownload.plugin.runtime.install.verify.PluginPackageVerifier;
import top.sywyar.pixivdownload.plugin.signature.ArtifactVerificationRequest;
import top.sywyar.pixivdownload.plugin.signature.PluginSupplyChainVerifier;
import top.sywyar.pixivdownload.plugin.signature.PluginTrustStores;
import top.sywyar.pixivdownload.plugin.signature.TrustedPluginKey;
import top.sywyar.pixivdownload.plugin.signature.SignatureMetadata;
import top.sywyar.pixivdownload.plugin.signature.community.CommunityOperation;
import top.sywyar.pixivdownload.plugin.signature.community.CommunityOperationVerificationRequest;
import top.sywyar.pixivdownload.plugin.signature.VerificationPolicy;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;
import top.sywyar.pixivdownload.sdk.community.identity.PluginBinding;
import top.sywyar.pixivdownload.sdk.community.identity.Publisher;
import top.sywyar.pixivdownload.sdk.community.operation.KeyRotationRequest;
import top.sywyar.pixivdownload.sdk.community.operation.OwnershipTransferRequest;
import top.sywyar.pixivdownload.sdk.community.operation.VersionStatusRequest;
import top.sywyar.pixivdownload.sdk.community.operation.VersionState;
import top.sywyar.pixivdownload.sdk.community.operation.OperationAudit;
import top.sywyar.pixivdownload.sdk.community.project.CommunityPaths;
import top.sywyar.pixivdownload.sdk.community.project.PluginProjectLocator;
import top.sywyar.pixivdownload.sdk.community.submission.DescriptorSnapshot;
import top.sywyar.pixivdownload.sdk.community.submission.LicenseTemplates;
import top.sywyar.pixivdownload.sdk.community.submission.MarketImages;
import top.sywyar.pixivdownload.sdk.community.submission.VersionSubmission;
import top.sywyar.pixivdownload.sdk.community.review.PublishedVersion;

/** 复用固定 SDK 的静态检查；不装载插件、不求值构建模型、不生成审核或发布事实。 */
public final class CommunitySubmission {
    private static final int INPUT_BYTES = 32 * 1024 * 1024;

    public static void main(String[] args) throws Exception {
        Utf8ConsoleStreams.install();
        if (args.length != 1) throw new IllegalArgumentException("COMMUNITY_ARGUMENTS");
        Path workspace = Path.of(args[0]);
        JsonNode input;
        try (var stream = Files.newInputStream(workspace.resolve("submission-input.json"))) {
            input = CommunityJson.strictTree(stream.readNBytes(INPUT_BYTES + 1), INPUT_BYTES);
        }
        Object result = switch (text(input, "command")) {
            case "document" -> document(input);
            case "projects" -> PluginProjectLocator.discover(Path.of(text(input, "gitRoot")));
            case "inspect" -> inspect(workspace, input, null, null);
            case "verify" -> verify(workspace, input);
            case "image" -> image(input);
            case "licenses" -> LicenseTemplates.available();
            case "license" -> license(workspace, input);
            case "canonical" -> canonical(workspace, input);
            case "verify-proof" -> proof(input);
            case "status" -> status(input);
            case "source" -> CommunitySource.unpack(workspace, input);
            case "maven-model" -> CommunityModel.maven(input);
            case "path" -> Map.of("path", CommunityPaths.resolve(Path.of(text(input, "root")), text(input, "path"),
                    input.path("allowRoot").asBoolean(), input.path("mustExist").asBoolean()).toString());
            case "limits" -> PluginPackageLimits.defaults();
            case "select" -> PluginProjectLocator.select(Path.of(text(input, "gitRoot")), text(input, "projectDir"),
                    text(input, "profileId"), text(input, "artifactPath"),
                    java.util.stream.StreamSupport.stream(input.get("outputs").spliterator(), false).map(JsonNode::textValue).toList()).profile();
            default -> throw new IllegalArgumentException("COMMUNITY_COMMAND");
        };
        System.out.println(new String(CommunityJson.encode(result), java.nio.charset.StandardCharsets.UTF_8));
    }

    private static String text(JsonNode input, String field) {
        if (!input.hasNonNull(field) || !input.get(field).isTextual()) throw new ContractException("SCHEMA_INVALID", "/" + field);
        return input.get(field).textValue();
    }

    private static Object license(Path workspace, JsonNode input) throws Exception {
        byte[] bytes = LicenseTemplates.bytes(text(input, "id"));
        Path file = Files.createTempFile(workspace, "license-", ".txt");
        Files.write(file, bytes);
        return Map.of("file", file.toString(), "size", bytes.length, "sha256", CommunityJson.sha256(bytes));
    }

    private static CommunityJson.Document read(String kind, String file) throws Exception {
        Path path = Path.of(file);
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw new ContractException("PATH_MISMATCH", "/file");
        try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            return CommunityJson.read(CommunityJson.Kind.valueOf(kind), stream);
        }
    }

    private static Object document(JsonNode input) throws Exception {
        var document = read(text(input, "kind"), text(input, "file"));
        String path = text(input, "path");
        CommunityPaths.relative(path, false);
        switch (document.kind()) {
            case PUBLISHER -> Publisher.read(document, path);
            case BINDING -> PluginBinding.read(document, path);
            case SUBMISSION -> VersionSubmission.read(document);
            case ROTATION -> KeyRotationRequest.read(document, path);
            case STATUS_REQUEST -> VersionStatusRequest.read(document, path);
            case TRANSFER -> OwnershipTransferRequest.read(document, path);
            case PUBLISHED -> PublishedVersion.read(document);
            case AUDIT -> {
                var audit = OperationAudit.read(document);
                if (!path.equals("audits/" + audit.requestId() + ".json")) throw new ContractException("PATH_MISMATCH", "/path");
            }
            default -> { }
        }
        return Map.of("value", document.value(), "sha256", document.sha256(), "size", document.bytes().length);
    }

    private static Object canonical(Path workspace, JsonNode input) throws Exception {
        var document = read(text(input, "kind"), text(input, "file"));
        byte[] bytes = CommunityJson.canonicalBody(document);
        Files.write(workspace.resolve("canonical.bin"), bytes);
        return Map.of("requestId", CommunityJson.sha256(bytes));
    }

    private static Object status(JsonNode input) throws Exception {
        var state = new VersionState(text(input, "pluginId"), text(input, "version"), text(input, "packageSha256"),
                VersionState.State.ACTIVE, null);
        for (JsonNode item : input.withArray("history")) {
            var document = read("STATUS_REQUEST", text(item, "file"));
            var p = document.value().get("payload");
            String requestId = document.value().get("requestId").textValue();
            var request = VersionStatusRequest.read(document, "version-status-requests/" + p.get("owner").get("accountId").textValue()
                    + "/" + p.get("pluginId").textValue() + "/" + p.get("version").textValue() + "/" + requestId + ".json");
            state = state.transition(request, text(item, "decisionSha256"));
        }
        return state;
    }

    private static Object proof(JsonNode input) throws Exception {
        var document = read(text(input, "kind"), text(input, "file"));
        JsonNode key = input.get("key");
        var trusted = new TrustedPluginKey(text(key, "keyId"), text(key, "algorithm"), text(key, "publicKeySpkiBase64"),
                TrustedPluginKey.State.ACTIVE, "community", "community", false);
        JsonNode signature = document.value().get("proofs").get(text(input, "proof"));
        var metadata = new SignatureMetadata(signature.get("formatVersion").intValue(), text(signature, "algorithm"),
                text(signature, "keyId"), text(signature, "value"));
        CommunityOperation operation = switch (document.kind()) {
            case ROTATION -> CommunityOperation.PUBLISHER_KEY_ROTATION;
            case STATUS_REQUEST -> CommunityOperation.VERSION_STATUS_REQUEST;
            case TRANSFER -> CommunityOperation.OWNERSHIP_TRANSFER;
            default -> throw new ContractException("SCHEMA_INVALID", "/kind");
        };
        var result = new PluginSupplyChainVerifier(PluginTrustStores.community(java.util.List.of(trusted)))
                .verifyCommunityOperation(new CommunityOperationVerificationRequest(operation, CommunityJson.canonicalBody(document),
                        document.value().get("requestId").textValue(), metadata, false));
        if (!result.accepted()) throw new ContractException("MALFORMED_SIGNATURE", "/proofs");
        return Map.of("fingerprint", result.publisherKeyFingerprint());
    }

    private static Object image(JsonNode input) throws Exception {
        try (var stream = Files.newInputStream(Path.of(text(input, "file")), LinkOption.NOFOLLOW_LINKS)) {
            return MarketImages.read(stream, input.path("icon").asBoolean());
        }
    }

    private static Object verify(Path workspace, JsonNode input) throws Exception {
        var submission = VersionSubmission.read(read("SUBMISSION", text(input, "submission")));
        var publisher = Publisher.read(read("PUBLISHER", text(input, "publisher")), text(input, "publisherPath"));
        if (!submission.publisherId().equals(publisher.publisherId())) throw new ContractException("BINDING_MISMATCH", "/publisherId");
        String expected = "submissions/" + publisher.githubAccount().id() + "/" + submission.pluginId() + "/" + submission.version() + ".json";
        if (!expected.equals(text(input, "path"))) throw new ContractException("PATH_MISMATCH", "/path");
        submission.verifyPreviousSource(input.path("previousReviewedCommit").isNull() ? null : text(input, "previousReviewedCommit"));
        submission.license().verifySourceFiles(Path.of(text(input, "sourceRoot")));
        var images = MarketImages.validate(Path.of(text(input, "imagesRoot")), publisher.githubAccount().id(),
                submission.pluginId(), submission.version(), submission.market());
        var result = inspect(workspace, input, submission, publisher);
        result.put("images", images);
        return result;
    }

    private static Map<String, Object> inspect(Path workspace, JsonNode input, VersionSubmission submission, Publisher publisher) throws Exception {
        Path source = Path.of(text(input, "file"));
        if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)) throw new ContractException("PATH_MISMATCH", "/file");
        var limits = PluginPackageLimits.defaults();
        String extension = source.getFileName().toString().endsWith(".jar") ? ".jar" : ".zip";
        Path frozen = Files.createTempFile(workspace, "package-", extension);
        try {
            long size = 0;
            var digest = MessageDigest.getInstance("SHA-256");
            // 所有后续检查消费同一次有界复制的字节，公开路径变化不能替换已验签输入。
            try (InputStream stream = Files.newInputStream(source, LinkOption.NOFOLLOW_LINKS); var out = Files.newOutputStream(frozen)) {
                byte[] buffer = new byte[8192];
                for (int n; (n = stream.read(buffer)) != -1;) {
                    size += n;
                    if (size > limits.maxArchiveBytes()) throw new ContractException("LIMIT_EXCEEDED", "/package");
                    out.write(buffer, 0, n);
                    digest.update(buffer, 0, n);
                }
            }
            var usage = PluginPackageVerifier.verifyAndMeasure(frozen, limits);
            var inspection = PluginPackageReader.inspect(frozen, limits);
            var descriptor = inspection.descriptor();
            if (!descriptor.externalValidationErrors().isEmpty()) throw new ContractException("DESCRIPTOR_MISMATCH", "/package");
            var snapshot = new DescriptorSnapshot(descriptor.requires().present() ? descriptor.requires().raw() : "*",
                    descriptor.executionMode().descriptorValue(), descriptor.dependencies(), descriptor.riskDeclaration());
            snapshot.validate();
            var result = new LinkedHashMap<String, Object>();
            result.put("pluginId", descriptor.id());
            result.put("version", descriptor.version());
            result.put("pluginClass", descriptor.pluginClass());
            result.put("displayName", descriptor.displayName());
            result.put("descriptor", snapshot);
            result.put("size", size);
            result.put("sha256", HexFormat.of().formatHex(digest.digest()));
            result.put("usage", usage);
            if (submission != null) {
                DescriptorSnapshot.from(descriptor, submission);
                if (!publisher.activeKey().keyId().equals(submission.artifact().signature().keyId())) {
                    throw new ContractException("BINDING_MISMATCH", "/package/signature/keyId");
                }
                var verification = new PluginSupplyChainVerifier(publisher.trustStore()).verifyArtifact(new ArtifactVerificationRequest(
                        frozen, submission.pluginId(), submission.version(), submission.artifact().expectedSize(),
                        submission.artifact().sha256(), submission.artifact().signature(), VerificationPolicy.customRepository()));
                if (!verification.accepted()) throw new ContractException("MALFORMED_SIGNATURE", "/package/signature");
                result.put("publisherKeyFingerprint", verification.publisherKeyFingerprint());
            }
            return result;
        } finally { Files.deleteIfExists(frozen); }
    }
}
