package com.civitas.server.application;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.AuthContextResolver;
import com.civitas.server.http.AuthInterceptor;
import com.civitas.server.http.BodyLimitFilter;
import com.civitas.server.http.IpRateLimitFilter;
import com.civitas.server.http.RateLimiter;
import com.civitas.server.http.SecurityHeadersFilter;
import com.civitas.server.http.WriteRateLimitInterceptor;
import com.civitas.server.json.Json;
import com.civitas.server.logging.JsonLogger;
import com.civitas.server.services.A2aService;
import com.civitas.server.services.AuthService;
import com.civitas.server.services.BackupService;
import com.civitas.server.services.MemoryService;
import com.civitas.server.services.SettingsService;
import com.civitas.server.services.StatsService;
import com.civitas.server.services.TaskService;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 基础设施装配：把 Bootstrap 中已就绪的配置/数据库/限流器接入 Spring 容器，
 * 并注册过滤器链（与 TS 版 `src/app.ts` 的钩子顺序一致）：
 *
 *   SecurityHeaders(1) → IpRateLimit(2) → Cors(3) → BodyLimit(4)
 */
@Configuration
public class InfrastructureConfiguration implements WebMvcConfigurer {

    @Bean
    public ServerConfig serverConfig() {
        return Bootstrap.config();
    }

    /**
     * 注意 destroyMethod=""：Bootstrap 的 Db 是跨容器共享的单例（测试里每个应用实例
     * 复用同一个连接池），不能让 Spring 在上下文关闭时按约定推断 close() 把它关掉。
     * 真实启动时由 ShutdownCleanup 统一关闭。
     */
    @Bean(destroyMethod = "")
    public Db db() {
        return Bootstrap.db();
    }

    @Bean(destroyMethod = "")
    public RateLimiter rateLimiter() {
        return Bootstrap.rateLimiter();
    }

    @Bean
    public FilterRegistrationBean<SecurityHeadersFilter> securityHeadersFilter() {
        FilterRegistrationBean<SecurityHeadersFilter> registration =
                new FilterRegistrationBean<>(new SecurityHeadersFilter());
        registration.setOrder(1);
        return registration;
    }

    @Bean
    public FilterRegistrationBean<IpRateLimitFilter> ipRateLimitFilter(ServerConfig cfg, RateLimiter limiter) {
        FilterRegistrationBean<IpRateLimitFilter> registration =
                new FilterRegistrationBean<>(new IpRateLimitFilter(cfg, limiter));
        registration.setOrder(2);
        return registration;
    }

    /** 允许浏览器客户端（可选）；Electron 直连时未配置来源则不启用（与 TS 版条件一致） */
    @Bean
    public FilterRegistrationBean<CorsFilter> corsFilter(ServerConfig cfg) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(cfg.corsOrigins());
        cors.setAllowedMethods(List.of("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        cors.setAllowedHeaders(List.of("Content-Type", "Authorization"));
        cors.setMaxAge(600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cors);
        FilterRegistrationBean<CorsFilter> registration = new FilterRegistrationBean<>(new CorsFilter(source));
        registration.setOrder(3);
        // 未配置来源 → 不注册进容器（与 TS 版「条件挂载 cors 钩子」一致）；
        // 注意 filter 实例不可为 null —— Boot 会扫描 Bean 的 getFilter()
        if (cfg.corsOrigins().isEmpty()) registration.setEnabled(false);
        return registration;
    }

    @Bean
    public FilterRegistrationBean<BodyLimitFilter> bodyLimitFilter(ServerConfig cfg) {
        FilterRegistrationBean<BodyLimitFilter> registration =
                new FilterRegistrationBean<>(new BodyLimitFilter(cfg.limits().bodyLimitBytes()));
        registration.setOrder(4);
        return registration;
    }

    /** 仅真实启动（main）时注册；测试构建的上下文不注册，避免误关共享资源 */
    @Bean
    @ConditionalOnProperty(name = "civitas.cleanupOnShutdown", havingValue = "true")
    public ShutdownCleanup shutdownCleanup(RateLimiter limiter, Db db) {
        return new ShutdownCleanup(limiter, db);
    }

    /** 历史刷新令牌定期清理（SV-004）；仅真实启动注册（测试不注册，避免后台线程干扰用例） */
    @Bean
    @ConditionalOnProperty(name = "civitas.cleanupOnShutdown", havingValue = "true")
    public TokenSweeper tokenSweeper(Db db) {
        return new TokenSweeper(db);
    }

    /** 就绪日志（与 TS 版 index.ts 的启动日志一致） */
    @Bean
    public ApplicationRunner readyLog(ServerConfig cfg) {
        return args -> JsonLogger.info(
                "Civitas 服务端已就绪 — http://" + cfg.host() + ":" + cfg.port(),
                Map.of(
                        "env", cfg.env().name(),
                        "host", cfg.host(),
                        "port", cfg.port(),
                        "statsTimezone", cfg.statsTimezone()));
    }

    @Bean
    public AuthService authService(ServerConfig cfg, Db db) {
        return new AuthService(db, cfg);
    }

    @Bean
    public SettingsService settingsService(ServerConfig cfg, Db db) {
        return new SettingsService(db, cfg);
    }

    @Bean
    public StatsService statsService(ServerConfig cfg, Db db) {
        return new StatsService(db, cfg);
    }

    @Bean
    public MemoryService memoryService(ServerConfig cfg, Db db) {
        return new MemoryService(db, cfg);
    }

    @Bean
    public TaskService taskService(Db db) {
        return new TaskService(db);
    }

    @Bean
    public BackupService backupService(Db db) {
        return new BackupService(db);
    }

    @Bean
    public A2aService a2aService(Db db) {
        return new A2aService(db);
    }

    /**
     * 鉴权拦截器（@RequireAuth 标注的路由）+ 写限流（按用户）。
     * 注册顺序即执行顺序：Auth 先注入身份，WriteRate 才能拿到 userId。
     */
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new AuthInterceptor(serverConfig(), db()))
                .order(0);
        registry.addInterceptor(new WriteRateLimitInterceptor(serverConfig(), rateLimiter()))
                .order(1);
    }

    /** 控制器方法声明 AuthContext 参数即可取当前身份 */
    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(new AuthContextResolver());
    }

    /** Spring MVC 的消息转换统一走全局 ObjectMapper（ISO 时间、未知字段容忍） */
    @Override
    public void extendMessageConverters(List<HttpMessageConverter<?>> converters) {
        for (HttpMessageConverter<?> converter : converters) {
            if (converter instanceof MappingJackson2HttpMessageConverter jackson) {
                jackson.setObjectMapper(Json.MAPPER);
                jackson.setSupportedMediaTypes(List.of(
                        new MediaType("application", "json", StandardCharsets.UTF_8),
                        new MediaType("application", "*+json", StandardCharsets.UTF_8)));
            }
        }
    }
}
