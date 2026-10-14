package com.civitas.server.services;

import com.civitas.server.config.ServerConfig;
import com.civitas.server.db.Db;
import com.civitas.server.http.Errors;
import com.civitas.server.json.IsoTimes;
import com.civitas.server.repositories.MemoriesRepository;
import com.civitas.server.repositories.RefreshTokensRepository;
import com.civitas.server.repositories.SettingsRepository;
import com.civitas.server.repositories.StatsRepository;
import com.civitas.server.repositories.StatsRepository.DailyTotal;
import com.civitas.server.repositories.StatsRepository.KindTotal;
import com.civitas.server.repositories.StatsRepository.LifetimeTotals;
import com.civitas.server.repositories.StatsRepository.RangeTotals;
import com.civitas.server.repositories.UsersRepository;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * 个人数据统计：上报（批量、幂等）+ 汇总 / 按日 / 概览
 * —— 与 TS 版 `src/services/statsService.ts` 对位。
 */
public final class StatsService {
    private final Db db;
    private final ServerConfig cfg;

    public StatsService(Db db, ServerConfig cfg) {
        this.db = db;
        this.cfg = cfg;
    }

    public record KindTotalDto(String kind, int count, double value) {}

    public record StatsSummaryDto(
            String from,
            String to,
            int totalEvents,
            double totalValue,
            int activeDays,
            List<KindTotalDto> byKind) {}

    public record DayTotalDto(String day, String kind, int count, double value) {}

    public record StatsDailyDto(String timezone, List<DayTotalDto> days) {}

    public record LoginRangeDto(
            int events,
            double value,
            int activeDays,
            String firstAt,
            String lastAt) {}

    public record MemoriesTotalDto(int total) {}

    public record SettingsRevisionDto(int revision) {}

    public record SessionsActiveDto(int active) {}

    public record AccountDatesDto(String createdAt, String lastLoginAt) {}

    public record StatsOverviewDto(
            LoginRangeDto lifetime,
            MemoriesTotalDto memories,
            SettingsRevisionDto settings,
            SessionsActiveDto sessions,
            AccountDatesDto account) {}

    public record IngestResult(int accepted, int submitted) {}

    public record ClearResult(int deleted) {}

    public IngestResult ingest(String userId, List<StatsRepository.UsageEventInput> events) {
        if (events.size() > cfg.limits().maxStatsEventsPerBatch()) {
            throw Errors.payloadTooLarge(
                    "单次最多上报 " + cfg.limits().maxStatsEventsPerBatch() + " 条事件",
                    Errors.details("max", cfg.limits().maxStatsEventsPerBatch(), "submitted", events.size()));
        }
        int accepted = StatsRepository.insertEvents(db, userId, events);
        return new IngestResult(accepted, events.size());
    }

    public StatsSummaryDto summary(String userId, Instant from, Instant to) {
        List<KindTotal> byKind = StatsRepository.summaryByKind(db, userId, from, to);
        RangeTotals totals = StatsRepository.rangeTotals(db, userId, from, to, cfg.statsTimezone());
        return new StatsSummaryDto(
                IsoTimes.format(from),
                IsoTimes.format(to),
                totals.events(),
                totals.value(),
                totals.activeDays(),
                byKind.stream().map(k -> new KindTotalDto(k.kind(), k.count(), k.value())).toList());
    }

    public StatsDailyDto daily(String userId, Instant from, Instant to, String kind) {
        List<DailyTotal> days = StatsRepository.dailyTotals(db, userId, from, to, cfg.statsTimezone(), kind);
        return new StatsDailyDto(
                cfg.statsTimezone(),
                days.stream().map(d -> new DayTotalDto(d.day(), d.kind(), d.count(), d.value())).toList());
    }

    public StatsOverviewDto overview(String userId) {
        LifetimeTotals lifetime = StatsRepository.lifetimeTotals(db, userId, cfg.statsTimezone());
        int memories = MemoriesRepository.countMemories(db, userId, null);
        SettingsRepository.SettingsRow settings = SettingsRepository.getSettings(db, userId);
        int sessions = RefreshTokensRepository.countActiveSessions(db, userId);
        UsersRepository.UserRow user = UsersRepository.findUserById(db, userId);
        return new StatsOverviewDto(
                new LoginRangeDto(
                        lifetime.events(),
                        lifetime.value(),
                        lifetime.activeDays(),
                        lifetime.firstAt() == null ? null : IsoTimes.format(lifetime.firstAt()),
                        lifetime.lastAt() == null ? null : IsoTimes.format(lifetime.lastAt())),
                new MemoriesTotalDto(memories),
                new SettingsRevisionDto(settings == null ? 0 : settings.revision()),
                new SessionsActiveDto(sessions),
                new AccountDatesDto(
                        user == null ? null : IsoTimes.format(user.createdAt()),
                        user == null || user.lastLoginAt() == null ? null : IsoTimes.format(user.lastLoginAt())));
    }

    public ClearResult clear(String userId) {
        return new ClearResult(StatsRepository.deleteAllEvents(db, userId));
    }

    /** 缺省区间：最近 30 天；to 缺省为当前时间（对位 TS 版 resolveRange） */
    public static Instant[] resolveRange(Instant from, Instant to, Instant now) {
        Instant resolvedTo = to != null ? to : now;
        Instant resolvedFrom = from != null ? from : resolvedTo.minus(Duration.ofDays(30));
        return new Instant[] { resolvedFrom, resolvedTo };
    }
}
