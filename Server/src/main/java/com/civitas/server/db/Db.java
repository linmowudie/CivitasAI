package com.civitas.server.db;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.json.Json;
import com.fasterxml.jackson.databind.JsonNode;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PostgreSQL 访问层：连接池 + 查询辅助 —— 与 TS 版 `src/db/pool.ts` 对位。
 *
 * 约定：
 *  - 所有 SQL 一律参数化，杜绝拼接注入；占位符支持 JDBC `?` 与 PG 风格 `$n`
 *    （`$n` 与 TS 版 SQL 逐字一致，便于两侧比对；绑定前统一翻译为 `?`）；
 *  - 行统一规范化为 JSON 友好类型（timestamptz→Instant、uuid→String、jsonb→String、int8→Long、numeric→BigDecimal）；
 *  - 事务通过 {@link #tx(Function)} 提供，回调抛错即回滚。
 *
 * 注意：`$n` 翻译按正则识别，SQL 字符串字面量里不要出现 `$` + 数字的组合。
 */
public final class Db {
    private final JdbcTemplate jdbc;
    private final HikariDataSource dataSource;
    private final boolean transactionScoped;

    private Db(JdbcTemplate jdbc, HikariDataSource dataSource, boolean transactionScoped) {
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.transactionScoped = transactionScoped;
    }

    /** 创建连接池实例 */
    public static Db create(String databaseUrl, ServerConfig.DbConfig cfg) {
        HikariConfig hikari = new HikariConfig();
        hikari.setJdbcUrl(jdbcUrl(databaseUrl));
        hikari.setMaximumPoolSize(cfg.poolMax());
        hikari.setMinimumIdle(0);
        hikari.setIdleTimeout(cfg.idleTimeoutMs());
        hikari.setConnectionTimeout(cfg.connectionTimeoutMs());
        // 构造期不探测连通性：由调用方 ping() 判定（与 TS 版 pg.Pool 的惰性连接一致）
        hikari.setInitializationFailTimeout(-1);
        hikari.setPoolName("civitas-server");
        hikari.addDataSourceProperty("ApplicationName", "civitas-server");
        // 与 node-postgres 的行为对齐：字符串参数按「未指定类型」发送，由 PG 依上下文推断
        // （jsonb 等列可直接绑定字符串参数；否则 JDBC 会以 varchar 发送导致类型不匹配）
        hikari.addDataSourceProperty("stringtype", "unspecified");
        // statement_timeout：随连接建立时下发（等价 TS 版 pg.Pool 的 statement_timeout）
        hikari.addDataSourceProperty("options", "-c statement_timeout=" + cfg.statementTimeoutMs());
        hikari.setRegisterMbeans(false);
        HikariDataSource dataSource = new HikariDataSource(hikari);
        return new Db(new JdbcTemplate(dataSource), dataSource, false);
    }

    /**
     * 配置里的连接串是 `postgres://user:pass@host:port/db?sslmode=...`（与 TS 版 pg 相同格式）。
     *
     * JDBC 不支持 URL 里的 `user@host` 部分（会把它当成主机名），必须拆出 userInfo
     * 转成查询参数；查询串（sslmode 等）原样保留。
     */
    public static String jdbcUrl(String databaseUrl) {
        if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
            return databaseUrl;
        }
        try {
            URI uri = URI.create(databaseUrl);
            StringBuilder jdbc = new StringBuilder("jdbc:postgresql://");
            jdbc.append(uri.getHost() == null ? "127.0.0.1" : uri.getHost());
            if (uri.getPort() != -1) jdbc.append(':').append(uri.getPort());
            jdbc.append(uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath());

            List<String> params = new ArrayList<>();
            if (uri.getQuery() != null && !uri.getQuery().isEmpty()) params.add(uri.getQuery());
            String userInfo = uri.getUserInfo();
            if (userInfo != null && !userInfo.isEmpty()) {
                int colon = userInfo.indexOf(':');
                String user = colon >= 0 ? userInfo.substring(0, colon) : userInfo;
                String password = colon >= 0 ? userInfo.substring(colon + 1) : null;
                params.add("user=" + urlEncode(user));
                if (password != null && !password.isEmpty()) params.add("password=" + urlEncode(password));
            }
            if (!params.isEmpty()) jdbc.append('?').append(String.join("&", params));
            return jdbc.toString();
        } catch (IllegalArgumentException e) {
            // 报错不回显原文，避免把口令写进日志
            throw new IllegalArgumentException(
                    "DATABASE_URL 解析失败: " + databaseUrl.replaceAll("://[^@/]+@", "://***@"), e);
        }
    }

    /** 查询参数编码（URLEncoder 的 '+' 会被 JDBC 侧按 URLDecoder 还原为空格，往返一致） */
    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    // ── 查询辅助 ────────────────────────────────────────────────────────

    public List<Map<String, Object>> query(String sql, Object... params) {
        Bound bound = bind(sql, params);
        return jdbc.query(bound.sql(), (rs, rowNum) -> normalizeRow(rs), bound.params());
    }

    /** 首行或 null */
    public Map<String, Object> one(String sql, Object... params) {
        List<Map<String, Object>> rows = query(sql, params);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 受影响行数 */
    public int execute(String sql, Object... params) {
        Bound bound = bind(sql, params);
        return jdbc.update(bound.sql(), bound.params());
    }

    /** 执行无参数 SQL（可为多语句/DDL；仅迁移器等内部调用） */
    public void executeRaw(String sql) {
        jdbc.execute(sql);
    }

    /**
     * 事务：回调使用同一连接；抛错自动回滚。
     *
     * 事务内再次调用 {@code tx} 直接复用（对位 TS 版的嵌套语义）。
     */
    public <T> T tx(Function<Db, T> fn) {
        if (transactionScoped) return fn.apply(this);
        return jdbc.execute((ConnectionCallback<T>) connection -> {
            boolean previousAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            JdbcTemplate txTemplate = new JdbcTemplate(new SingleConnectionDataSource(connection, true));
            Db txDb = new Db(txTemplate, null, true);
            try {
                T result = fn.apply(txDb);
                connection.commit();
                return result;
            } catch (RuntimeException | Error e) {
                try {
                    connection.rollback();
                } catch (SQLException ignored) {
                    // 回滚失败：连接可能已断，忽略并抛出原始错误
                }
                throw e;
            } finally {
                try {
                    connection.setAutoCommit(previousAutoCommit);
                } catch (SQLException ignored) {
                    // 恢复失败交由连接释放时处理
                }
            }
        });
    }

    /** 连通性探测 */
    public boolean ping() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public void close() {
        if (dataSource != null) dataSource.close();
    }

    // ── 占位符绑定（$n → ?，与 TS 版 SQL 逐字兼容）─────────────────────

    record Bound(String sql, Object[] params) {}

    /** PG 风格占位符 `$1`、`$2`…（支持同一参数多次引用） */
    private static final Pattern PG_PLACEHOLDER = Pattern.compile("\\$(\\d+)");

    /** 包级可见以便单测（DbBindingTest） */
    static Bound bind(String sql, Object[] params) {
        if (params == null || params.length == 0 || sql.indexOf('$') < 0) {
            return new Bound(sql, normalizeParams(params));
        }
        Matcher matcher = PG_PLACEHOLDER.matcher(sql);
        StringBuilder rewritten = new StringBuilder(sql.length());
        List<Object> ordered = new ArrayList<>();
        int cursor = 0;
        while (matcher.find()) {
            int index = Integer.parseInt(matcher.group(1)) - 1;
            if (index < 0 || index >= params.length) {
                throw new IllegalArgumentException(
                        "SQL 占位符越界: " + matcher.group() + "（共 " + params.length + " 个参数）");
            }
            rewritten.append(sql, cursor, matcher.start()).append('?');
            ordered.add(params[index]);
            cursor = matcher.end();
        }
        rewritten.append(sql, cursor, sql.length());
        return new Bound(rewritten.toString(), normalizeParams(ordered.toArray()));
    }

    // ── 类型规范化（对位 pg 的类型解析行为）────────────────────────────

    private static Object[] normalizeParams(Object[] params) {
        if (params == null || params.length == 0) return new Object[0];
        Object[] out = new Object[params.length];
        for (int i = 0; i < params.length; i++) {
            out[i] = normalizeParam(params[i]);
        }
        return out;
    }

    private static Object normalizeParam(Object param) {
        if (param instanceof Instant instant) {
            return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
        }
        if (param instanceof JsonNode node) {
            return node.toString();
        }
        if (param instanceof Map<?, ?> || param instanceof List<?>) {
            try {
                return Json.MAPPER.writeValueAsString(param);
            } catch (Exception e) {
                throw new IllegalArgumentException("JSON 参数序列化失败", e);
            }
        }
        return param;
    }

    private static Map<String, Object> normalizeRow(ResultSet rs) throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        Map<String, Object> row = new LinkedHashMap<>();
        for (int i = 1; i <= meta.getColumnCount(); i++) {
            row.put(meta.getColumnLabel(i), normalizeColumn(rs.getObject(i)));
        }
        return row;
    }

    private static Object normalizeColumn(Object value) {
        if (value == null) return null;
        if (value instanceof UUID uuid) return uuid.toString();
        if (value instanceof OffsetDateTime odt) return odt.toInstant();
        if (value instanceof Timestamp ts) return ts.toInstant();
        if (value instanceof java.sql.Date date) return date.toLocalDate();
        // jsonb 等 PGobject（按类名判断，避免运行期 scope 的驱动出现在编译类路径）
        if ("org.postgresql.util.PGobject".equals(value.getClass().getName())) {
            return String.valueOf(value);
        }
        return value;
    }

    // ── 行读取辅助（服务/仓储层用）──────────────────────────────────────

    public static String str(Map<String, Object> row, String column) {
        Object value = row.get(column);
        return value == null ? null : String.valueOf(value);
    }

    public static boolean bool(Map<String, Object> row, String column) {
        Object value = row.get(column);
        return value instanceof Boolean b && b;
    }

    public static Long longOf(Map<String, Object> row, String column) {
        Object value = row.get(column);
        if (value == null) return null;
        if (value instanceof Number number) return number.longValue();
        return Long.parseLong(String.valueOf(value));
    }

    public static Instant instantOf(Map<String, Object> row, String column) {
        Object value = row.get(column);
        if (value == null) return null;
        if (value instanceof Instant instant) return instant;
        if (value instanceof OffsetDateTime odt) return odt.toInstant();
        if (value instanceof Timestamp ts) return ts.toInstant();
        throw new IllegalStateException("列 " + column + " 不是时间类型: " + value.getClass());
    }
}
