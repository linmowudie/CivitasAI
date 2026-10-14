package com.civitas.server.http;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * 请求体大小限制 —— 与 Fastify 的 `bodyLimit` 行为对位。
 *
 * 两层防护：
 *  1. Content-Length 预检：声明超限直接 413（不读体）；
 *  2. 流式计数：chunked/无 Content-Length 的请求在读取过程中超限即中止（413）。
 *
 * 超限错误体与 TS 版一致：PAYLOAD_TOO_LARGE『请求体过大』。
 */
public final class BodyLimitFilter extends OncePerRequestFilter {
    private final long limitBytes;

    public BodyLimitFilter(long limitBytes) {
        this.limitBytes = limitBytes;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String contentLength = request.getHeader("Content-Length");
        if (contentLength != null && !contentLength.isEmpty()) {
            try {
                if (Long.parseLong(contentLength.trim()) > limitBytes) {
                    ApiResponse.writeError(response, new AppException(
                            ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大"));
                    return;
                }
            } catch (NumberFormatException ignored) {
                // 非法 Content-Length 交给容器/后续解析处理
            }
        }
        try {
            chain.doFilter(new BodyLimitedRequest(request, limitBytes), response);
        } catch (BodyTooLargeException e) {
            if (!response.isCommitted()) {
                response.resetBuffer();
                ApiResponse.writeError(response, new AppException(ApiErrorCode.PAYLOAD_TOO_LARGE, "请求体过大"));
            } else {
                throw e;
            }
        }
    }

    /** 包装请求：读取的字节数超过上限即抛 {@link BodyTooLargeException} */
    private static final class BodyLimitedRequest extends HttpServletRequestWrapper {
        private final long limitBytes;

        BodyLimitedRequest(HttpServletRequest request, long limitBytes) {
            super(request);
            this.limitBytes = limitBytes;
        }

        @Override
        public ServletInputStream getInputStream() throws IOException {
            return new CountingServletInputStream(super.getInputStream(), limitBytes);
        }

        @Override
        public BufferedReader getReader() throws IOException {
            Charset charset = getCharacterEncoding() != null
                    ? Charset.forName(getCharacterEncoding()) : StandardCharsets.UTF_8;
            return new BufferedReader(new InputStreamReader(getInputStream(), charset));
        }
    }

    /** 计数输入流：累计读取字节数，超限抛 BodyTooLargeException（不会被吞掉） */
    private static final class CountingServletInputStream extends ServletInputStream {
        private final ServletInputStream delegate;
        private final long limitBytes;
        private long count;

        CountingServletInputStream(ServletInputStream delegate, long limitBytes) {
            this.delegate = delegate;
            this.limitBytes = limitBytes;
        }

        private void count(long read) {
            if (read <= 0) return;
            count += read;
            if (count > limitBytes) throw new BodyTooLargeException();
        }

        @Override
        public int read() throws IOException {
            int value = delegate.read();
            if (value != -1) count(1);
            return value;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int read = delegate.read(b, off, len);
            count(read);
            return read;
        }

        @Override
        public boolean isFinished() {
            return delegate.isFinished();
        }

        @Override
        public boolean isReady() {
            return delegate.isReady();
        }

        @Override
        public void setReadListener(ReadListener readListener) {
            delegate.setReadListener(readListener);
        }

        @Override
        public long skip(long n) throws IOException {
            long skipped = delegate.skip(n);
            count(skipped);
            return skipped;
        }

        @Override
        public int available() throws IOException {
            return delegate.available();
        }

        @Override
        public void close() throws IOException {
            delegate.close();
        }
    }
}
