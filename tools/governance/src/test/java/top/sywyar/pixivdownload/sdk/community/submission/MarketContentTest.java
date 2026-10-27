package top.sywyar.pixivdownload.sdk.community.submission;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import top.sywyar.pixivdownload.sdk.community.content.MarketContent;
import top.sywyar.pixivdownload.sdk.community.format.CommunityJson;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.*;

@DisplayName("投稿市场文档合同")
class MarketContentTest {
    @Test
    @DisplayName("新字段可选，显式空链接保留，未知字段继续拒绝")
    void roundTripsOptionalContract() throws Exception {
        var old = fixture();
        var parsed = read(old);
        assertThat(parsed.content()).isNull();
        assertThat(parsed.market().links()).isNull();
        ((ObjectNode) old.get("market")).putArray("links");
        assertThat(read(old).market().links()).isEmpty();
        var content = new MarketContent(Map.of("en", document()), null, null);
        old.set("content", CommunityJson.strictTree(CommunityJson.encode(content), 65536));
        parsed = read(old);
        assertThat(parsed.content().readme().get("en").asset().sha256()).isEqualTo("a".repeat(64));
        assertThat(CommunityJson.strictTree(CommunityJson.encode(parsed.content()), 65536).has("changelog")).isFalse();
        ((ObjectNode) old.get("content")).put("executable", true);
        assertThatThrownBy(() -> read(old)).isInstanceOf(ContractException.class);
    }

    @Test
    @DisplayName("文档来源地址绑定投稿仓库与冻结提交，旧文档仍可省略")
    void frozenDocumentSource() throws Exception {
        var value = fixture();
        var original = document();
        String prefix = value.path("source").path("repository").asText() + "/blob/"
                + value.path("source").path("commit").asText() + "/";
        var content = new MarketContent(Map.of("en", new MarketContent.Document(original.format(), original.asset(),
                original.sourcePath(), original.resources(), prefix + "README.md")), null, null);
        value.set("content", CommunityJson.strictTree(CommunityJson.encode(content), 65536));
        assertThat(read(value).content().readme().get("en").sourceUrl()).isEqualTo(prefix + "README.md");
        var document = (ObjectNode) value.path("content").path("readme").path("en");
        for (String invalid : List.of(prefix.replace("/blob/", "/tree/") + "README.md",
                prefix + "other.md", prefix + "README.md#install",
                "https://github.com/other/repository/blob/" + "f".repeat(40) + "/README.md",
                prefix.replace(value.path("source").path("commit").asText(), "e".repeat(40)) + "README.md")) {
            document.put("sourceUrl", invalid);
            assertThatThrownBy(() -> read(value)).isInstanceOf(ContractException.class);
        }
        document.remove("sourceUrl");
        assertThat(read(value).content().readme().get("en").sourceUrl()).isNull();
    }

    private static MarketContent.Document document() {
        return new MarketContent.Document("markdown", new MarketContent.Asset("content-" + "a".repeat(64) + ".md",
                "https://example.org/README.en.md", "text/markdown", 10, "a".repeat(64)), "README.md", Map.of());
    }
    private static ObjectNode fixture() throws Exception {
        try (var input = MarketContentTest.class.getResourceAsStream("/community/v1/vectors/submission.json")) {
            return (ObjectNode) CommunityJson.parse(CommunityJson.Kind.SUBMISSION, input.readAllBytes()).value();
        }
    }
    private static VersionSubmission read(ObjectNode node) {
        return VersionSubmission.read(CommunityJson.parse(CommunityJson.Kind.SUBMISSION, CommunityJson.encode(node)));
    }
}
