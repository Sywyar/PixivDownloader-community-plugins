package example.review;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import org.pf4j.Plugin;

/** This URL uses a private handler that returns constant bytes without opening a connection. */
public final class MemoryUrlPlugin extends Plugin {
    public static InputStream openSample() throws IOException {
        return new URL(null, "memory:review-example", new URLStreamHandler() {
            @Override
            protected URLConnection openConnection(URL url) {
                return new URLConnection(url) {
                    @Override
                    public void connect() { }

                    @Override
                    public InputStream getInputStream() {
                        return new ByteArrayInputStream("in-memory sample".getBytes(StandardCharsets.UTF_8));
                    }
                };
            }
        }).openStream();
    }
}
