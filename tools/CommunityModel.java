import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.xpath.XPathFactory;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import top.sywyar.pixivdownload.sdk.community.format.ContractException;

/** 只解析 Maven 已求值的有效模型；不把源 POM 当作最终构建事实。 */
final class CommunityModel {
    static Object maven(JsonNode input) throws Exception {
        Path file = Path.of(input.get("file").textValue());
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 32 * 1024 * 1024) {
            throw new ContractException("LIMIT_EXCEEDED", "/model");
        }
        var factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        Element project;
        try (var stream = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            project = factory.newDocumentBuilder().parse(stream).getDocumentElement();
        }
        if (!project.getTagName().equals("project")) throw new ContractException("SCHEMA_INVALID", "/model");
        var xpath = XPathFactory.newInstance().newXPath();
        String version = xpath.evaluate("version", project);
        String directory = xpath.evaluate("build/directory", project);
        String name = xpath.evaluate("build/finalName", project);
        Node jar = (Node) xpath.evaluate("build/plugins/plugin[artifactId='maven-jar-plugin']/configuration", project,
                javax.xml.xpath.XPathConstants.NODE);
        if (jar != null) {
            String customDirectory = xpath.evaluate("outputDirectory", jar);
            String customName = xpath.evaluate("finalName", jar);
            String classifier = xpath.evaluate("classifier", jar);
            if (!customDirectory.isEmpty()) directory = customDirectory;
            if (!customName.isEmpty()) name = customName;
            if (!classifier.isEmpty()) name += "-" + classifier;
        }
        var dependencies = new ArrayList<Map<String, String>>();
        NodeList nodes = (NodeList) xpath.evaluate("dependencies/dependency", project, javax.xml.xpath.XPathConstants.NODESET);
        for (int i = 0; i < nodes.getLength(); i++) {
            Node dependency = nodes.item(i);
            dependencies.add(Map.of("group", xpath.evaluate("groupId", dependency),
                    "name", xpath.evaluate("artifactId", dependency), "version", xpath.evaluate("version", dependency),
                    "scope", xpath.evaluate("scope", dependency)));
        }
        if (version.isBlank() || directory.isBlank() || name.isBlank() || (version + directory + name).contains("${")) {
            throw new ContractException("BUILD_OUTPUT_MISMATCH", "/model");
        }
        return Map.of("version", version, "artifacts", List.of(Path.of(directory).resolve(name + ".jar").toString()),
                "dependencies", dependencies);
    }
}
