package com.civitas.server.helpers;

import com.civitas.server.config.ServerConfig;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;

/**
 * 集成测试基类 —— 与 TS 版各 spec 文件“每用例前清表、数据库不可用即跳过”的行为对位。
 *
 * 子类如需自定义配置，覆盖 {@link #buildApp()}。
 */
public abstract class IntegrationTest {
    protected static TestApp app;

    @BeforeAll
    static void startApp() {
        Assumptions.assumeTrue(TestDb.isDbAvailable(), "测试数据库不可用，跳过集成测试");
        app = buildApp();
    }

    @AfterAll
    static void stopApp() {
        if (app != null) {
            app.close();
            app = null;
        }
    }

    @BeforeEach
    void truncateBusinessTables() {
        TestDb.truncateAll(TestDb.getTestDb());
    }

    /** 默认 testConfig；子类可覆盖以定制配置 */
    protected static TestApp buildApp() {
        return TestApp.build(TestConfig.testConfig());
    }

    protected static ServerConfig cfg() {
        return app.cfg;
    }

    protected static ApiClient client() {
        return app.client;
    }
}
