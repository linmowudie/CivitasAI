/**
 * 数据库迁移系统（Docs/10 §1 / Gate G1）
 *
 * 职责：
 * - 版本化迁移管理（up/down 幂等）
 * - 迁移版本追踪（_migrations 表）
 * - 支持 up（应用迁移）和 down（回滚迁移）
 *
 * Gate G1 要求：迁移可上可下（up/down 幂等）
 */

import type Database from 'better-sqlite3';
import { getMainDb, getEventsDb, getMemoryDb } from './database.js';
import type { Result } from '../types.js';
import { ok, err } from '../types.js';

// ===== 类型定义 =====

/** 单个迁移定义 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
  readonly database?: 'main' | 'events' | 'memory';
}

/** 迁移状态 */
export interface MigrationStatus {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
}

// ===== 内部状态 =====

const migrations: Migration[] = [];
let defaultsRegistered = false;

// ===== 公开 API =====

export function registerMigration(migration: Migration): void {
  migrations.push(migration);
  migrations.sort((a, b) => a.version - b.version);
}

/**
 * 注册所有默认迁移（S1 基础表）· 可重复调用（幂等）
 */
export function registerDefaultMigrations(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;

  // --- Main DB ---
  registerMigration({ version: 1, name: 'create_sessions', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY, trace_id TEXT, user_id TEXT, description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, archived_at INTEGER
    );`,
    down: `DROP TABLE IF EXISTS sessions;`,
  });
  registerMigration({ version: 2, name: 'create_agents', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_agent_id TEXT,
      role TEXT NOT NULL, system_prompt TEXT NOT NULL, task_prompt TEXT,
      allowed_tools TEXT, denied_tools TEXT, token_budget INTEGER,
      max_iterations INTEGER DEFAULT 30, timeout_ms INTEGER,
      trust_level TEXT NOT NULL DEFAULT 'L1', sandbox_enabled INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'creating', failure_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, destroyed_at INTEGER,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agents_trace ON agents(trace_id);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);`,
    down: `DROP TABLE IF EXISTS agents;`,
  });
  registerMigration({ version: 3, name: 'create_tasks', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, trace_id TEXT NOT NULL,
      user_request TEXT NOT NULL, route_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      estimated_tokens INTEGER, required_domains TEXT, coupling_score REAL,
      final_result TEXT, quality_score REAL,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      FOREIGN KEY (session_key) REFERENCES sessions(session_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id);`,
    down: `DROP TABLE IF EXISTS tasks;`,
  });
  registerMigration({ version: 4, name: 'create_subtasks', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS subtasks (
      subtask_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, trace_id TEXT NOT NULL,
      description TEXT NOT NULL, input_context TEXT, output_schema TEXT, assigned_agent_id TEXT,
      max_iterations INTEGER NOT NULL DEFAULT 30, timeout_ms INTEGER, token_budget INTEGER,
      status TEXT NOT NULL DEFAULT 'pending', result TEXT, quality_score REAL,
      failure_count INTEGER DEFAULT 0, failure_reason TEXT,
      depends_on TEXT, required_tools TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);`,
    down: `DROP TABLE IF EXISTS subtasks;`,
  });
  registerMigration({ version: 5, name: 'create_token_wallets', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS token_wallets (
      wallet_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0, total_earned REAL NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0, total_tax_paid REAL NOT NULL DEFAULT 0,
      total_frozen REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wallets_agent ON token_wallets(agent_id);`,
    down: `DROP TABLE IF EXISTS token_wallets;`,
  });
  registerMigration({ version: 6, name: 'create_token_transactions', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS token_transactions (
      transaction_id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL,
      trace_id TEXT, operation_id TEXT, type TEXT NOT NULL,
      amount REAL NOT NULL, balance_after REAL NOT NULL,
      description TEXT, metadata TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (wallet_id) REFERENCES token_wallets(wallet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_wallet ON token_transactions(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON token_transactions(type);`,
    down: `DROP TABLE IF EXISTS token_transactions;`,
  });
  registerMigration({ version: 7, name: 'create_system_config', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS system_config (
      config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL,
      description TEXT, updated_at INTEGER NOT NULL, updated_by TEXT
    );`,
    down: `DROP TABLE IF EXISTS system_config;`,
  });

  // --- S2 持久执行底座（Docs/10 §8.2）---
  registerMigration({ version: 8, name: 'create_loops', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS loops (
      loop_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, session_key TEXT NOT NULL,
      agent_id TEXT NOT NULL, task_id TEXT NOT NULL, parent_agent_id TEXT,
      goal_json TEXT NOT NULL, state_json TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL,
      budget_used_tokens INTEGER NOT NULL DEFAULT 0,
      budget_used_usd REAL NOT NULL DEFAULT 0,
      last_checkpoint_id TEXT, stopped_reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_loops_active ON loops(phase, updated_at)
      WHERE phase NOT IN ('completed','failed');
    CREATE INDEX IF NOT EXISTS idx_loops_trace ON loops(trace_id);`,
    down: `DROP TABLE IF EXISTS loops;`,
  });
  registerMigration({ version: 9, name: 'create_loop_checkpoints', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS loop_checkpoints (
      checkpoint_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, state_snapshot_json TEXT NOT NULL,
      artifact_manifest_json TEXT NOT NULL, pending_effects_json TEXT NOT NULL,
      next_step_hint TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_loop_iter ON loop_checkpoints(loop_id, iteration DESC);`,
    down: `DROP TABLE IF EXISTS loop_checkpoints;`,
  });
  registerMigration({ version: 10, name: 'create_effect_journal', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS effect_journal (
      effect_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, error_class TEXT,
      started_at INTEGER NOT NULL, timeout_ms INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(loop_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_effect_status ON effect_journal(status, started_at);
    CREATE INDEX IF NOT EXISTS idx_effect_loop ON effect_journal(loop_id, iteration);`,
    down: `DROP TABLE IF EXISTS effect_journal;`,
  });
  registerMigration({ version: 11, name: 'create_idempotency_cache', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS idempotency_cache (
      idem_key TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      result_json TEXT NOT NULL, result_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_cache(expires_at);`,
    down: `DROP TABLE IF EXISTS idempotency_cache;`,
  });

  // --- S6 Loop 控制（Docs/10 §8.2）---
  registerMigration({ version: 12, name: 'create_verifier_results', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS verifier_results (
      result_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, level TEXT NOT NULL,
      verifier_kind TEXT NOT NULL, pass INTEGER NOT NULL,
      evidence_json TEXT NOT NULL, defect_category TEXT,
      cost_tokens INTEGER, duration_ms INTEGER,
      judge_model TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_verifier_loop ON verifier_results(loop_id, iteration);`,
    down: `DROP TABLE IF EXISTS verifier_results;`,
  });
  registerMigration({ version: 13, name: 'create_failure_feedbacks', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS failure_feedbacks (
      feedback_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, category TEXT NOT NULL,
      evidence_json TEXT NOT NULL, compared_with_last_json TEXT,
      tried_strategies_json TEXT NOT NULL, remaining_budget_json TEXT NOT NULL,
      recommended_next_action TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );`,
    down: `DROP TABLE IF EXISTS failure_feedbacks;`,
  });
  registerMigration({ version: 14, name: 'create_strategies_ledger', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS strategies_ledger (
      entry_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, strategy TEXT NOT NULL,
      expected_outcome TEXT NOT NULL, actual_outcome TEXT,
      failure_reason TEXT, created_at INTEGER NOT NULL,
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );`,
    down: `DROP TABLE IF EXISTS strategies_ledger;`,
  });
  registerMigration({ version: 15, name: 'create_pending_approvals', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id TEXT PRIMARY KEY, loop_id TEXT NOT NULL,
      trace_id TEXT NOT NULL, iteration INTEGER NOT NULL,
      requested_by TEXT NOT NULL, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, risk_level TEXT NOT NULL,
      requested_at INTEGER NOT NULL, timeout_sec INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      deciders_json TEXT NOT NULL,
      decision_policy TEXT NOT NULL DEFAULT 'majority',
      decided_by_json TEXT, decided_at INTEGER,
      decision_reason TEXT,
      default_on_timeout TEXT NOT NULL DEFAULT 'reject',
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON pending_approvals(status, expires_at);`,
    down: `DROP TABLE IF EXISTS pending_approvals;`,
  });
  registerMigration({ version: 2, name: 'create_action_fingerprints', database: 'events',
    up: `CREATE TABLE IF NOT EXISTS action_fingerprints (
      fingerprint TEXT NOT NULL, loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL, tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL, count_in_iteration INTEGER NOT NULL DEFAULT 1,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (fingerprint, loop_id, iteration)
    );
    CREATE INDEX IF NOT EXISTS idx_fp_loop ON action_fingerprints(loop_id, iteration);`,
    down: `DROP TABLE IF EXISTS action_fingerprints;`,
  });

  // --- Events DB ---
  registerMigration({ version: 1, name: 'create_events', database: 'events',
    up: `CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, trace_id TEXT,
      source TEXT NOT NULL, payload TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal', created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);`,
    down: `DROP TABLE IF EXISTS events;`,
  });

  // --- F0.7 会话与消息（Docs/16）---
  registerMigration({ version: 18, name: 'create_chat_sessions', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(status);`,
    down: `DROP TABLE IF EXISTS chat_sessions;`,
  });
  registerMigration({ version: 19, name: 'create_chat_messages', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS chat_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT, tokens_used INTEGER, trace_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);`,
    down: `DROP TABLE IF EXISTS chat_messages;`,
  });

  // ── S8 事件总线与共享记忆 ──────────────────────────────────────────
  registerMigration({ version: 16, name: 'create_global_workspace', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS global_workspace (
      entry_id TEXT PRIMARY KEY, key TEXT NOT NULL,
      trace_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT,
      content TEXT NOT NULL, content_type TEXT NOT NULL,
      assertion TEXT NOT NULL DEFAULT 'observed',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      last_modified_by TEXT NOT NULL,
      conflict_strategy TEXT NOT NULL DEFAULT 'lww',
      causal_tokens_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      superseded_by TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gw_key ON global_workspace(key);
    CREATE INDEX IF NOT EXISTS idx_gw_trace ON global_workspace(trace_id);
    CREATE INDEX IF NOT EXISTS idx_gw_agent ON global_workspace(agent_id);`,
    down: `DROP TABLE IF EXISTS global_workspace;`,
  });
  registerMigration({ version: 17, name: 'create_long_term_memory', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS long_term_memory (
      memory_id TEXT PRIMARY KEY,
      title TEXT NOT NULL, content TEXT NOT NULL,
      category TEXT NOT NULL,
      source_trace_ids_json TEXT NOT NULL DEFAULT '[]',
      source_arbitration_ids_json TEXT,
      assertion TEXT NOT NULL DEFAULT 'observed',
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      contradicted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_category ON long_term_memory(category);
    CREATE INDEX IF NOT EXISTS idx_ltm_status ON long_term_memory(status);`,
    down: `DROP TABLE IF EXISTS long_term_memory;`,
  });
  registerMigration({ version: 3, name: 'create_domain_events', database: 'events',
    up: `CREATE TABLE IF NOT EXISTS domain_events (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
      trace_id TEXT, loop_id TEXT,
      source TEXT NOT NULL, payload TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      published_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_de_type ON domain_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_de_trace ON domain_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_de_loop ON domain_events(loop_id);`,
    down: `DROP TABLE IF EXISTS domain_events;`,
  });
}

export function initMigrations(): Result<void> {
  try {
    registerDefaultMigrations();
    const createMigrationsTable = `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `;
    getMainDb().exec(createMigrationsTable);
    getEventsDb().exec(createMigrationsTable);
    getMemoryDb().exec(createMigrationsTable);
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`迁移系统初始化失败: ${message}`, 'FATAL');
  }
}

/**
 * 应用所有待迁移（up）
 */
export function migrateUp(): Result<number> {
  try {
    let applied = 0;
    for (const migration of migrations) {
      const db = getDbForMigration(migration);
      if (!isApplied(db, migration.version)) {
        db.exec(migration.up);
        db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
          migration.version, migration.name,
        );
        applied++;
      }
    }
    return ok(applied);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`迁移 up 失败: ${message}`, 'FATAL');
  }
}

/**
 * 回滚最新一次迁移（down）
 */
export function migrateDown(): Result<number> {
  try {
    const db = getMainDb();
    const lastMigration = db.prepare(
      'SELECT version, name FROM _migrations ORDER BY version DESC LIMIT 1',
    ).get() as { version: number; name: string } | undefined;

    if (!lastMigration) return ok(0);

    const migration = migrations.find(m => m.version === lastMigration.version);
    if (!migration) return ok(0);

    const targetDb = getDbForMigration(migration);
    targetDb.exec(migration.down);
    targetDb.prepare('DELETE FROM _migrations WHERE version = ?').run(migration.version);
    return ok(1);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`迁移 down 失败: ${message}`, 'FATAL');
  }
}

/**
 * 获取已应用的迁移列表
 */
export function getAppliedMigrations(db: 'main' | 'events' | 'memory' = 'main'): MigrationStatus[] {
  const database = getDb(db);
  return database.prepare(
    'SELECT version, name, applied_at FROM _migrations ORDER BY version ASC',
  ).all() as MigrationStatus[];
}

/**
 * 获取当前迁移版本
 */
export function getCurrentVersion(db: 'main' | 'events' | 'memory' = 'main'): number {
  const database = getDb(db);
  const row = database.prepare(
    'SELECT MAX(version) as version FROM _migrations',
  ).get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function clearMigrations(): void {
  migrations.length = 0;
  defaultsRegistered = false;
}

// ===== 内部函数 =====

function getDb(name: 'main' | 'events' | 'memory'): Database.Database {
  switch (name) {
    case 'main': return getMainDb();
    case 'events': return getEventsDb();
    case 'memory': return getMemoryDb();
  }
}

function getDbForMigration(migration: Migration): Database.Database {
  return getDb(migration.database ?? 'main');
}

function isApplied(db: Database.Database, version: number): boolean {
  const row = db.prepare('SELECT 1 FROM _migrations WHERE version = ?').get(version);
  return row !== undefined;
}

