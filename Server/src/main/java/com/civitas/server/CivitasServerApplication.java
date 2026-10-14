package com.civitas.server;

import com.civitas.server.application.Bootstrap;
import com.civitas.server.cli.MigrationCli;
import com.civitas.server.config.ServerConfig;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Map;

/**
 * 服务端入口 —— 与 TS 版 `src/index.ts` 对位：
 * 加载配置 → 连接数据库 → 构建应用 → 监听 → 优雅退出；失败即退出（fail-fast）。
 *
 * 数据库连接自管理（Bootstrap + Db），因此排除 Spring 的 DataSource 自动装配。
 * 迁移子命令（--migrate / --migrate-status）由 {@link MigrationCli} 拦截处理，不启动 Web 服务。
 */
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
public class CivitasServerApplication {

    public static void main(String[] args) {
        if (MigrationCli.intercepts(args)) {
            System.exit(MigrationCli.run(args));
        }

        Bootstrap.fromEnvironment();
        ServerConfig cfg = Bootstrap.config();

        SpringApplication application = new SpringApplication(CivitasServerApplication.class);
        application.setDefaultProperties(Map.of(
                "server.address", cfg.host(),
                "server.port", String.valueOf(cfg.port()),
                // 仅真实启动时注册退资源清理（测试上下文不受影响）
                "civitas.cleanupOnShutdown", "true"));
        try {
            application.run(args);
        } catch (Exception e) {
            StringWriter stack = new StringWriter();
            e.printStackTrace(new PrintWriter(stack));
            System.err.println("✖ 服务端启动失败: " + stack);
            System.exit(1);
        }
    }
}
