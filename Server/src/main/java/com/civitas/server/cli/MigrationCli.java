package com.civitas.server.cli;

import com.civitas.server.config.ConfigLoader;
import com.civitas.server.db.MigrationRunner;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 迁移 CLI —— 与 TS 版 `scripts/migrate.ts` 对位。
 *
 * 用法（等价 npm run migrate / migrate:status / --dry-run）：
 *   java -jar civitas-server.jar --migrate
 *   java -jar civitas-server.jar --migrate-status
 *   java -jar civitas-server.jar --migrate --dry-run
 */
public final class MigrationCli {
    private MigrationCli() {}

    /** 是否为迁移子命令（由 main 拦截；不启动 Web 服务） */
    public static boolean intercepts(String[] args) {
        for (String arg : args) {
            if ("--migrate".equals(arg) || "--migrate-status".equals(arg)) return true;
        }
        return false;
    }

    public static int run(String[] args) {
        boolean status = false;
        boolean dryRun = false;
        for (String arg : args) {
            if ("--migrate-status".equals(arg)) status = true;
            if ("--dry-run".equals(arg)) dryRun = true;
        }

        ConfigLoader.LoadConfigResult result = ConfigLoader.loadConfig(ConfigLoader.readEnv());
        if (!result.ok() || result.config() == null) {
            System.err.println("✖ 配置校验失败：");
            for (String error : result.errors()) System.err.println("  - " + error);
            return 1;
        }
        String databaseUrl = result.config().databaseUrl();

        try (Connection connection = MigrationRunner.open(databaseUrl)) {
            try (Statement statement = connection.createStatement();
                 ResultSet rs = statement.executeQuery("SELECT 1")) {
                rs.next();
            }

            Path migrationsDir = ConfigLoader.serverRoot().resolve("migrations");
            if (status) {
                printStatus(connection, migrationsDir);
            } else {
                MigrationRunner.MigrateResult migrated = MigrationRunner.runMigrations(
                        connection, migrationsDir, dryRun);
                if (migrated.alreadyUpToDate()) {
                    System.out.println("✔ 数据库已是最新（" + migrated.skipped().size() + " 个迁移全部已应用）");
                } else {
                    System.out.println((dryRun ? "（dry-run）将执行" : "✔ 已执行")
                            + " " + migrated.applied().size() + " 个迁移：");
                    for (String name : migrated.applied()) System.out.println("  - " + name);
                }
            }
            return 0;
        } catch (SQLException e) {
            System.err.println("✖ 无法连接数据库，请检查 DATABASE_URL 与数据库是否已启动：");
            System.err.println("   " + databaseUrl.replaceAll("://[^@]+@", "://***@"));
            return 1;
        } catch (Exception e) {
            System.err.println("✖ 迁移失败: " + (e.getMessage() != null ? e.getMessage() : String.valueOf(e)));
            return 1;
        }
    }

    private static void printStatus(Connection connection, Path migrationsDir) throws SQLException {
        List<MigrationRunner.MigrationFile> files = MigrationRunner.loadMigrations(migrationsDir);
        List<MigrationRunner.AppliedMigration> applied = MigrationRunner.listApplied(connection);
        Set<String> appliedNames = applied.stream()
                .map(MigrationRunner.AppliedMigration::name)
                .collect(Collectors.toSet());
        System.out.println("迁移目录: " + migrationsDir);
        System.out.println("已应用: " + applied.size() + " / 共 " + files.size() + "\n");
        for (MigrationRunner.MigrationFile file : files) {
            MigrationRunner.AppliedMigration matched = applied.stream()
                    .filter(item -> item.name().equals(file.name()))
                    .findFirst().orElse(null);
            System.out.println("  " + (appliedNames.contains(file.name()) ? "✔" : "·") + " " + file.name()
                    + (matched != null ? "  (" + matched.appliedAt() + ")" : "  [待执行]"));
        }
    }
}
