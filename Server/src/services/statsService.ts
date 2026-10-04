/**
 * @module services/statsService
 * @description 个人数据统计：上报（批量、幂等）+ 汇总 / 按日 / 概览。
 */

import type { ServerConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { payloadTooLarge } from '../http/errors.js';
import * as repo from '../repositories/stats.js';
import { countMemories } from '../repositories/memories.js';
import { countActiveSessions } from '../repositories/refreshTokens.js';
import { getSettings } from '../repositories/settings.js';
import { findUserById } from '../repositories/users.js';

export interface StatsSummaryDto {
  from: string;
  to: string;
  totalEvents: number;
  totalValue: number;
  activeDays: number;
  byKind: { kind: string; count: number; value: number }[];
}

export interface StatsDailyDto {
  timezone: string;
  days: { day: string; kind: string; count: number; value: number }[];
}

export interface StatsOverviewDto {
  lifetime: { events: number; value: number; activeDays: number; firstAt: string | null; lastAt: string | null };
  memories: { total: number };
  settings: { revision: number };
  sessions: { active: number };
  account: { createdAt: string | null; lastLoginAt: string | null };
}

export interface StatsService {
  ingest(
    userId: string,
    events: repo.UsageEventInput[],
  ): Promise<{ accepted: number; submitted: number }>;
  summary(userId: string, from: Date, to: Date): Promise<StatsSummaryDto>;
  daily(userId: string, from: Date, to: Date, kind?: string): Promise<StatsDailyDto>;
  overview(userId: string): Promise<StatsOverviewDto>;
  clear(userId: string): Promise<{ deleted: number }>;
}

export function createStatsService(deps: { db: Db; cfg: ServerConfig }): StatsService {
  const { db, cfg } = deps;

  return {
    async ingest(userId, events) {
      if (events.length > cfg.limits.maxStatsEventsPerBatch) {
        throw payloadTooLarge(
          `单次最多上报 ${cfg.limits.maxStatsEventsPerBatch} 条事件`,
          { max: cfg.limits.maxStatsEventsPerBatch, submitted: events.length },
        );
      }
      const accepted = await repo.insertEvents(db, userId, events);
      return { accepted, submitted: events.length };
    },

    async summary(userId, from, to) {
      const [byKind, totals] = await Promise.all([
        repo.summaryByKind(db, userId, from, to),
        repo.rangeTotals(db, userId, from, to, cfg.statsTimezone),
      ]);
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        totalEvents: totals.events,
        totalValue: totals.value,
        activeDays: totals.activeDays,
        byKind,
      };
    },

    async daily(userId, from, to, kind) {
      const days = await repo.dailyTotals(db, userId, from, to, cfg.statsTimezone, kind);
      return { timezone: cfg.statsTimezone, days };
    },

    async overview(userId) {
      const [lifetime, memories, settings, sessions, user] = await Promise.all([
        repo.lifetimeTotals(db, userId, cfg.statsTimezone),
        countMemories(db, userId),
        getSettings(db, userId),
        countActiveSessions(db, userId),
        findUserById(db, userId),
      ]);
      return {
        lifetime: {
          events: lifetime.events,
          value: lifetime.value,
          activeDays: lifetime.activeDays,
          firstAt: lifetime.firstAt ? new Date(lifetime.firstAt).toISOString() : null,
          lastAt: lifetime.lastAt ? new Date(lifetime.lastAt).toISOString() : null,
        },
        memories: { total: memories },
        settings: { revision: settings?.revision ?? 0 },
        sessions: { active: sessions },
        account: {
          createdAt: user ? new Date(user.created_at).toISOString() : null,
          lastLoginAt: user?.last_login_at ? new Date(user.last_login_at).toISOString() : null,
        },
      };
    },

    async clear(userId) {
      const deleted = await repo.deleteAllEvents(db, userId);
      return { deleted };
    },
  };
}
