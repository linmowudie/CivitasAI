package com.civitas.server.db;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 SQL 迁移执行器 —— 与 TS 版 `src/db/migrate.ts` 对位。
 *
 * 行为：
 *  - 迁移文件 `migrations/NNN_name.sql`，按文件名升序执行；
 *  - 每个文件在独立事务中执行；失败即回滚且不记录；
 *  - 记录 checksum（sha256）：已应用迁移的内容若被改动，直接报错拒绝启动（防漂移）。
 *
 * 兼容性（关键）：checksum 为「文件内容的 UTF-8 字符串」的 sha256 —— 与 TS 版
 * `createHash('sha256').update(sql)`（sql 为 utf8 解码后的字符串）逐字节一致。
 */
public final class MigrationRunner {
    private MigrationRunner() {}

    public record MigrationFile(String version, String name, String sql, String checksum) {}

    public record AppliedMigration(String version, String name, String checksum, String appliedAt) {}

    public record MigrateResult(List<String> applied, List<String> skipped, boolean alreadyUpToDate) {}

    /** 读取迁移目录（按文件名排序） */
    public static List<MigrationFile> loadMigrations(Path dir) {
        if (!Files.isDirectory(dir)) {
            throw new IllegalStateException("迁移目录不存在: " + dir);
        }
        try (var stream = Files.list(dir)) {
            List<Path> files = stream
                    .filter(path -> path.getFileName().toString().endsWith(".sql"))
                    .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                    .toList();
            List<MigrationFile> migrations = new ArrayList<>(files.size());
            for (Path path : files) {
                String name = path.getFileName().toString();
                String sql = new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
                String version = name.split("_")[0];
                migrations.add(new MigrationFile(version, name, sql, sha256Hex(sql)));
            }
            return migrations;
        } catch (Exception e) {
            throw new IllegalStateException("迁移文件读取失败: " + dir, e);
        }
    }

    public static void ensureMigrationsTable(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                  version     text PRIMARY KEY,
                  name        text NOT NULL,
                  checksum    text NOT NULL,
                  applied_at  timestamptz NOT NULL DEFAULT now(),
                  duration_ms integer NOT NULL DEFAULT 0
                )
                """);
        }
    }

    /** 列出已应用迁移 */
    public static List<AppliedMigration> listApplied(Connection connection) throws SQLException {
        ensureMigrationsTable(connection);
        List<AppliedMigration> result = new ArrayList<>();
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(
                     "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC")) {
            while (rs.next()) {
                Object appliedAt = rs.getObject("applied_at");
                result.add(new AppliedMigration(
                        rs.getString("version"),
                        rs.getString("name"),
                        rs.getString("checksum"),
                        formatAppliedAt(appliedAt)));
            }
        }
        return result;
    }

    /** 显示格式对齐 TS 版（pg Date 经 console.log 输出为 JS Date.toString 风格） */
    private static String formatAppliedAt(Object appliedAt) {
        if (appliedAt == null) return null;
        if (appliedAt instanceof java.time.OffsetDateTime odt) {
            return new java.util.Date(odt.toInstant().toEpochMilli()).toString();
        }
        return String.valueOf(appliedAt);
    }

    /** 执行迁移（dryRun 仅报告将要执行的内容，不落库） */
    public static MigrateResult runMigrations(Connection connection, Path dir, boolean dryRun) throws SQLException {
        List<MigrationFile> files = loadMigrations(dir);
        ensureMigrationsTable(connection);
        List<AppliedMigration> applied = listApplied(connection);
        Map<String, AppliedMigration> appliedByVersion = new LinkedHashMap<>();
        for (AppliedMigration item : applied) appliedByVersion.put(item.version(), item);

        // 1) 漂移检查：已应用迁移的内容不得变化
        for (MigrationFile file : files) {
            AppliedMigration previous = appliedByVersion.get(file.version());
            if (previous != null && !previous.checksum().equals(file.checksum())) {
                throw new IllegalStateException(
                        "迁移 " + file.name() + " 内容已变更（checksum 不一致）：已应用的迁移不可修改，请新增迁移文件");
            }
        }

        // 2) 待执行
        List<MigrationFile> pending = files.stream()
                .filter(file -> !appliedByVersion.containsKey(file.version()))
                .toList();
        if (pending.isEmpty()) {
            return new MigrateResult(List.of(), files.stream().map(MigrationFile::name).toList(), true);
        }
        if (dryRun) {
            return new MigrateResult(pending.stream().map(MigrationFile::name).toList(), List.of(), false);
        }

        List<String> appliedNames = new ArrayList<>();
        for (MigrationFile file : pending) {
            long startedAt = System.currentTimeMillis();
            boolean previousAutoCommit = connection.getAutoCommit();
            connection.setAutoCommit(false);
            try {
                try (Statement statement = connection.createStatement()) {
                    statement.execute(file.sql());
                }
                try (PreparedStatement statement = connection.prepareStatement(
                        "INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES (?, ?, ?, ?)")) {
                    statement.setString(1, file.version());
                    statement.setString(2, file.name());
                    statement.setString(3, file.checksum());
                    statement.setLong(4, System.currentTimeMillis() - startedAt);
                    statement.executeUpdate();
                }
                connection.commit();
            } catch (SQLException | RuntimeException e) {
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
                    // 恢复失败交由连接关闭时处理
                }
            }
            appliedNames.add(file.name());
        }
        return new MigrateResult(appliedNames, List.of(), false);
    }

    /**
     * 打开迁移专用连接（`preferQueryMode=simple`）。
     *
     * 迁移文件是**多语句 SQL**，扩展协议不允许一次发送多条语句；
     * 简单协议与服务端逐条执行的行为等价。
     */
    public static Connection open(String databaseUrl) throws SQLException {
        String url = Db.jdbcUrl(databaseUrl);
        url = url.contains("?")
                ? url + "&preferQueryMode=simple"
                : url + "?preferQueryMode=simple";
        return DriverManager.getConnection(url);
    }

    /** 用独立连接执行迁移 */
    public static MigrateResult run(String databaseUrl, Path dir, boolean dryRun) throws SQLException {
        try (Connection connection = open(databaseUrl)) {
            return runMigrations(connection, dir, dryRun);
        }
    }

    static String sha256Hex(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }
}
