package com.civitas.server.helpers;

import com.civitas.server.config.ConfigLoader;
import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.db.MigrationRunner;

import java.nio.file.Path;

/**
 * 集成测试用数据库：连接、迁移、清表 —— 与 TS 版 `test/helpers/pg.ts` 对位。
 *
 * 连接串优先级：TEST_DATABASE_URL > 默认本地测试库。
 * 若数据库不可用，集成测试会**跳过**（并打印提示），保证无库环境也能跑单元测试。
 */
public final class TestDb {
    public static final String TEST_DATABASE_URL = System.getenv("TEST_DATABASE_URL") != null
            ? System.getenv("TEST_DATABASE_URL")
            : "postgres://postgres@127.0.0.1:55432/civitas_server_test";

    private static final Path MIGRATIONS_DIR = ConfigLoader.serverRoot().resolve("migrations");

    private static Db cachedDb;
    private static Boolean available;

    private TestDb() {}

    /** 探测测试库是否可用（结果缓存；首次可用时执行迁移） */
    public static synchronized boolean isDbAvailable() {
        if (available != null) return available;
        Db probe = null;
        try {
            probe = Db.create(TEST_DATABASE_URL, new ServerConfig.DbConfig(5, 5_000, 1_500, 15_000));
            available = probe.ping();
            if (available) {
                MigrationRunner.run(TEST_DATABASE_URL, MIGRATIONS_DIR, false);
            }
        } catch (Exception e) {
            available = false;
        }
        if (!available) {
            if (probe != null) probe.close();
            System.err.println("\n[test] 跳过集成测试：测试数据库不可用（"
                    + TEST_DATABASE_URL.replaceAll("://[^@]*@", "://***@") + "）\n"
                    + "       启动方式：docker compose up -d db（见 Server/docker-compose.yml）\n");
        } else {
            cachedDb = probe;
        }
        return available;
    }

    /** 取测试库连接（与运行中的服务共享缓存实例） */
    public static synchronized Db getTestDb() {
        if (cachedDb == null) {
            if (!isDbAvailable() || cachedDb == null) throw new IllegalStateException("测试数据库不可用");
        }
        return cachedDb;
    }

    /** 清空全部业务表（每个用例前调用；保留 schema_migrations） */
    public static void truncateAll(Db db) {
        db.execute("""
            TRUNCATE TABLE
              audit_log, verification_codes, user_devices, usage_events, memories,
                a2a_messages, a2a_agent_cards, user_tasks,
              user_settings, refresh_tokens, users
            RESTART IDENTITY CASCADE
            """);
    }

    public static synchronized void closeTestDb() {
        if (cachedDb != null) {
            cachedDb.close();
            cachedDb = null;
            available = null;
        }
    }
}
