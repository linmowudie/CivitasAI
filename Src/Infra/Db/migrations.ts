/**
 * 数据库迁移系统（Docs/Agent/09 §1 / Gate G1）
 *
 * 职责：
 * - 版本化迁移管理（up/down 幂等）
 * - 迁移版本追踪（_migrations 表）
 * - 支持 up（应用迁移）和 down（回滚迁移）
 *
 * Gate G1 要求：迁移可上可下（up/down 幂等）
 */

import type Database from 'better-sqlite3';

import type { Result } from '../types.js';
import { ok, err } from '../types.js';

import { getMainDb, getEventsDb, getMemoryDb } from './database.js';

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

  // --- S2 持久执行底座（Docs/Agent/09 §8.2）---
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

  // --- S6 Loop 控制（Docs/Agent/09 §8.2）---
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

  // --- F0.7 会话与消息（Docs/Client/02）---
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
  // 会话工作目录：任务/会话绑定一个工作目录（默认 <项目根>/Data/workspaces/<sessionId>/）
  registerMigration({ version: 20, name: 'add_chat_sessions_work_dir', database: 'main',
    up: `ALTER TABLE chat_sessions ADD COLUMN work_dir TEXT;`,
    down: `ALTER TABLE chat_sessions DROP COLUMN work_dir;`,
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
  // v21：长时记忆增加"属主"维度（跨账号数据隔离，FE-032）
  //  - 本地记忆此前是"机器级"的：同机换账号后，B 会看到并上传 A 的记忆（实测已污染云端）
  //  - 改为复合主键 (owner_user_id, memory_id)：未登录用 'local'，登录后用服务端 userId
  //  - 因 SQLite 不支持修改主键，这里重建表并迁移既有数据（归入 'local'）
  //  - 先 `CREATE TABLE IF NOT EXISTS` 兜底 v17 形状：保证 down 之后再 up 仍可重放（Gate G1 幂等）
  registerMigration({ version: 21, name: 'add_long_term_memory_owner', database: 'main',
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
    CREATE TABLE IF NOT EXISTS long_term_memory_v21 (
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      memory_id TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL,
      category TEXT NOT NULL,
      source_trace_ids_json TEXT NOT NULL DEFAULT '[]',
      source_arbitration_ids_json TEXT,
      assertion TEXT NOT NULL DEFAULT 'observed',
      created_at INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      contradicted_by TEXT,
      PRIMARY KEY (owner_user_id, memory_id)
    );
    INSERT OR IGNORE INTO long_term_memory_v21
      (owner_user_id, memory_id, title, content, category, source_trace_ids_json,
       source_arbitration_ids_json, assertion, created_at, last_accessed_at,
       access_count, status, contradicted_by)
      SELECT 'local', memory_id, title, content, category, source_trace_ids_json,
             source_arbitration_ids_json, assertion, created_at, last_accessed_at,
             access_count, status, contradicted_by
      FROM long_term_memory;
    DROP TABLE long_term_memory;
    ALTER TABLE long_term_memory_v21 RENAME TO long_term_memory;
    CREATE INDEX IF NOT EXISTS idx_ltm_category ON long_term_memory(category);
    CREATE INDEX IF NOT EXISTS idx_ltm_status ON long_term_memory(status);
    CREATE INDEX IF NOT EXISTS idx_ltm_owner ON long_term_memory(owner_user_id, created_at);`,
    down: `DROP TABLE IF EXISTS long_term_memory;`,
  });
  // v22：**个人数据按账号隔离**（FE-032 扩展）
  //  会话/消息、任务、共享工作区、审批队列、运行轨迹、Token 账本都曾是"机器级"数据：
  //  同机换账号后 B 能看到 A 的会话与上下文，甚至把 A 的用量算进自己的统计。
  //  统一加 owner_user_id（未登录 = 'local'，登录 = 服务端 userId），
  //  读写一律按当前属主过滤（见 Src/Services/AccountScope/activeAccount.ts）。
  //
  //  注意：SQLite 的 `ALTER TABLE ... ADD COLUMN` **不支持 IF NOT EXISTS**
  //  （那是 Postgres 语法）；迁移本身由 `_migrations` 保证只执行一次，故直接 ADD 即可。
  registerMigration({ version: 22, name: 'add_owner_scope_to_personal_data', database: 'main',
    up: `ALTER TABLE chat_sessions      ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE chat_messages      ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE tasks              ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE subtasks           ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE global_workspace   ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE pending_approvals  ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE loops              ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE effect_journal     ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE token_wallets      ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE token_transactions ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions(owner_user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_owner ON chat_messages(owner_user_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_gw_owner ON global_workspace(owner_user_id, key);
    CREATE INDEX IF NOT EXISTS idx_approvals_owner ON pending_approvals(owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_loops_owner ON loops(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_effects_owner ON effect_journal(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_token_tx_owner ON token_transactions(owner_user_id, created_at);`,
    // down 必须真正回滚，否则 up→down→up 幂等门禁会失败（列已存在 → 再次 ADD 报 duplicate column）
    down: `DROP INDEX IF EXISTS idx_chat_sessions_owner;
    DROP INDEX IF EXISTS idx_chat_messages_owner;
    DROP INDEX IF EXISTS idx_tasks_owner;
    DROP INDEX IF EXISTS idx_gw_owner;
    DROP INDEX IF EXISTS idx_approvals_owner;
    DROP INDEX IF EXISTS idx_loops_owner;
    DROP INDEX IF EXISTS idx_effects_owner;
    DROP INDEX IF EXISTS idx_token_tx_owner;
    ALTER TABLE chat_sessions      DROP COLUMN owner_user_id;
    ALTER TABLE chat_messages      DROP COLUMN owner_user_id;
    ALTER TABLE tasks              DROP COLUMN owner_user_id;
    ALTER TABLE subtasks           DROP COLUMN owner_user_id;
    ALTER TABLE global_workspace   DROP COLUMN owner_user_id;
    ALTER TABLE pending_approvals  DROP COLUMN owner_user_id;
    ALTER TABLE loops              DROP COLUMN owner_user_id;
    ALTER TABLE effect_journal     DROP COLUMN owner_user_id;
    ALTER TABLE token_wallets      DROP COLUMN owner_user_id;
    ALTER TABLE token_transactions DROP COLUMN owner_user_id;`,
  });
  // 说明：memory 库（civitas_memory.db）的表结构见文件末尾 "--- Memory DB ---" 段；
  // `memory_entries` 曾长期未创建（FE-034），现由 v1 建立并按属主（owner_user_id）隔离。
  // v23：**AI 组件族内容的持久化**（重启后重建组件）
  //
  // 问题：会话重开后只剩纯文本 —— 思考（CoTFolder）、工具卡片（ToolGroup）、
  // 分段/子容器（MessageShell + segments）、内嵌审批卡等**全部丢失**。
  // 根因：`chat_messages` 只存 role/content（MessageBubble 里甚至写着
  // "历史消息没有 segments，回退为正文渲染"）。
  //
  // 方案（两层，缺一不可）：
  //  ① 消息富结构：把组件渲染所需的 reasoning/toolCalls/segments/totalIterations/error/status 随消息落库；
  //  ② AI 事件流：组件族是**事件驱动**的（按 eventTypes 注册，payload 来自事件），
  //     故把会话内的事件也持久化，可回放重建（覆盖 loop/memory/multiagent 等尚无专门字段的组件）。
  registerMigration({ version: 23, name: 'persist_ai_components', database: 'main',
    up: `ALTER TABLE chat_messages ADD COLUMN reasoning TEXT;
    ALTER TABLE chat_messages ADD COLUMN tool_calls_json TEXT;
    ALTER TABLE chat_messages ADD COLUMN segments_json TEXT;
    ALTER TABLE chat_messages ADD COLUMN total_iterations INTEGER;
    ALTER TABLE chat_messages ADD COLUMN error TEXT;
    ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
    CREATE TABLE IF NOT EXISTS ai_events (
      event_id      TEXT PRIMARY KEY,
      session_id    TEXT,
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      type          TEXT NOT NULL,
      data_json     TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      seq           INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ai_events_session ON ai_events(owner_user_id, session_id, ts, seq);
    CREATE INDEX IF NOT EXISTS idx_ai_events_type ON ai_events(type, ts);`,
    down: `DROP INDEX IF EXISTS idx_ai_events_session;
    DROP INDEX IF EXISTS idx_ai_events_type;
    DROP TABLE IF EXISTS ai_events;
    ALTER TABLE chat_messages DROP COLUMN reasoning;
    ALTER TABLE chat_messages DROP COLUMN tool_calls_json;
    ALTER TABLE chat_messages DROP COLUMN segments_json;
    ALTER TABLE chat_messages DROP COLUMN total_iterations;
    ALTER TABLE chat_messages DROP COLUMN error;
    ALTER TABLE chat_messages DROP COLUMN status;`,
  });
  // v24：**审批队列落库可用化**（FE-004）
  //
  // 背景：pending_approvals（v15 建表）全库零写入方 —— 审批队列一直只存进程内 Map。
  // 要做 write-through 落库（重启回滚 + 已决历史可见，FE-005），必须先解决两点：
  //  ① FK 陷阱：pending_approvals.loop_id 外键指向 loops，而 loops 表在运行期
  //     **零 INSERT**（仅 recoveryScanner 读），FK 约束会让运行期写入直接失败 ——
  //     故重建表去掉该外键（审批与 Loop 行的强绑定在内存态由队列保证）；
  //  ② 补齐工具关联列（tool_call_id/tool_name/session_id）与 auto_approved，
  //     与 PendingApproval 的落库字段对齐。
  registerMigration({ version: 24, name: 'rebuild_pending_approvals_for_persistence', database: 'main',
    up: `CREATE TABLE pending_approvals_v24 (
      approval_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      timeout_sec INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      deciders_json TEXT NOT NULL,
      decision_policy TEXT NOT NULL DEFAULT 'majority',
      decided_by_json TEXT,
      decided_at INTEGER,
      decision_reason TEXT,
      default_on_timeout TEXT NOT NULL DEFAULT 'reject',
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      tool_call_id TEXT,
      tool_name TEXT,
      session_id TEXT,
      auto_approved INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO pending_approvals_v24 (
      approval_id, loop_id, trace_id, iteration, requested_by, kind, payload_json, risk_level,
      requested_at, timeout_sec, expires_at, status, deciders_json, decision_policy,
      decided_by_json, decided_at, decision_reason, default_on_timeout, owner_user_id
    ) SELECT
      approval_id, loop_id, trace_id, iteration, requested_by, kind, payload_json, risk_level,
      requested_at, timeout_sec, expires_at, status, deciders_json, decision_policy,
      decided_by_json, decided_at, decision_reason, default_on_timeout, owner_user_id
    FROM pending_approvals;
    DROP TABLE pending_approvals;
    ALTER TABLE pending_approvals_v24 RENAME TO pending_approvals;
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON pending_approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_owner ON pending_approvals(owner_user_id, status);`,
    // down 还原 v22 形态（含 FK、不含工具关联列），保证 up→down→up 幂等
    down: `CREATE TABLE pending_approvals_v24_down (
      approval_id TEXT PRIMARY KEY,
      loop_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      timeout_sec INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      deciders_json TEXT NOT NULL,
      decision_policy TEXT NOT NULL DEFAULT 'majority',
      decided_by_json TEXT,
      decided_at INTEGER,
      decision_reason TEXT,
      default_on_timeout TEXT NOT NULL DEFAULT 'reject',
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      FOREIGN KEY (loop_id) REFERENCES loops(loop_id) ON DELETE CASCADE
    );
    INSERT INTO pending_approvals_v24_down (
      approval_id, loop_id, trace_id, iteration, requested_by, kind, payload_json, risk_level,
      requested_at, timeout_sec, expires_at, status, deciders_json, decision_policy,
      decided_by_json, decided_at, decision_reason, default_on_timeout, owner_user_id
    ) SELECT
      approval_id, loop_id, trace_id, iteration, requested_by, kind, payload_json, risk_level,
      requested_at, timeout_sec, expires_at, status, deciders_json, decision_policy,
      decided_by_json, decided_at, decision_reason, default_on_timeout, owner_user_id
    FROM pending_approvals;
    DROP TABLE pending_approvals;
    ALTER TABLE pending_approvals_v24_down RENAME TO pending_approvals;
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON pending_approvals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_owner ON pending_approvals(owner_user_id, status);`,
  });
  // v25：副作用日志关联工具调用 ID（FE-027）
  //  统计 `tool.call` 需"全量覆盖所有工具调用"且"不重复计数"：
  //  - 数据源 A：`ai_events` 的 `agent:tool_call_result`（每次工具调用一条，覆盖安全只读工具）；
  //  - 数据源 B：`effect_journal`（危险/非幂等工具，历史上已按 `eff:<effect_id>` 幂等键同步过）。
  //  两者若各自发事件就会**重复计数**，因此需要精确配对：effect 行记录触发它的 `tool_call_id`。
  //
  //  注意：历史上 Qoder 的 FE-004 已占用 v24（rebuild_pending_approvals_for_persistence），
  //  本条必须是 v25 —— 撞号会被 `isApplied()` 静默跳过（现已由 initMigrations 的冲突检测拦住）。
  registerMigration({ version: 25, name: 'add_effect_journal_tool_call_id', database: 'main',
    up: `ALTER TABLE effect_journal ADD COLUMN tool_call_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_effect_tool_call ON effect_journal(tool_call_id);`,
    down: `DROP INDEX IF EXISTS idx_effect_tool_call;
    ALTER TABLE effect_journal DROP COLUMN tool_call_id;`,
  });
  // v26：任务（会话）归档（2026-10-03 新功能）
  //  归档是**软状态**：`archived_at` 非空表示已归档；不删除任何消息，
  //  任务仍可打开、可取消归档，并继续参与统计与同步（服务端 user_tasks 保存归档状态）。
  registerMigration({ version: 26, name: 'add_chat_sessions_archived_at', database: 'main',
    up: `ALTER TABLE chat_sessions ADD COLUMN archived_at INTEGER;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(owner_user_id, archived_at);`,
    down: `DROP INDEX IF EXISTS idx_chat_sessions_archived;
    ALTER TABLE chat_sessions DROP COLUMN archived_at;`,
  });
  // v27：Agent 计划清单（TODO，2026-10-03 新功能）
  //  **按来源 agent 归属**：多 agent 且部分平级，因此每个 agent 在会话内各有一张独立计划表，
  //  键为 (owner_user_id, session_id, agent_id)，平级 agent 互不覆盖；面板按 agent 分组展示。
  registerMigration({ version: 27, name: 'create_session_todos', database: 'main',
    up: `CREATE TABLE IF NOT EXISTS session_todos (
      todo_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_role TEXT,
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_todos_scope
      ON session_todos(owner_user_id, session_id, agent_id, position);`,
    down: `DROP INDEX IF EXISTS idx_session_todos_scope;
    DROP TABLE IF EXISTS session_todos;`,
  });
  // v28：Agent 注册表落库（多 Agent 核心，2026-10-03）
  //  背景：`agents` 表自早期迁移就存在，但**从无代码读写** —— 招募出的 Agent 只活在内存 Map 里，
  //  进程重启即消失，也无法按账号隔离。本迁移补 owner 作用域，配合 agentRepository 做实落库。
  registerMigration({ version: 28, name: 'add_agents_owner_scope', database: 'main',
    up: `ALTER TABLE agents ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id, trace_id);`,
    down: `DROP INDEX IF EXISTS idx_agents_owner;
    ALTER TABLE agents DROP COLUMN owner_user_id;`,
  });
  // 注（2026-10-04）：`global_workspace.owner_user_id` **已由既有迁移统一添加**（见上方"统一加 owner_user_id"
//   迁移，含 `idx_gw_owner` 索引），因此 G-13③ 只需补齐**读写接线**（`globalWorkspace` 写穿落库 +
//   按属主隔离读取 + 启动回灌），无需新增迁移。此处曾误加 v29 迁移导致 `duplicate column`，已删除。
// ═══ v29（2026-10-04）：治理动作台账落库（G-10 后续）════════════════════════
// 背景：治理留痕此前仅存进程内数组 —— 重启即丢，无法满足灵感源 §1.2「全链路可追溯」。
//   本表按属主隔离（owner_user_id），字段对应四类强制元数据 + 动作语义。
registerMigration({ version: 29, name: 'create_governance_records', database: 'main',
  up: `
    CREATE TABLE IF NOT EXISTS governance_records (
      record_id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      actor_role TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      trace_id TEXT,
      task_id TEXT,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT,
      target_ids_json TEXT,
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gov_time ON governance_records(owner_user_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_gov_action ON governance_records(action, timestamp DESC);
  `,
  down: `DROP TABLE IF EXISTS governance_records;`,
});
// ═══ v30（2026-10-04）：长时记忆向量列（FE-058 语义检索）══════════════
// 背景：`embeddingClient` 实现齐备但全库 0 消费——语义检索不存在。
//   本列存条目向量（JSON 数组）；未配置嵌入模型时列留空（检索走文本打分），
//   配置后由检索器后台逐步补齐（语义重排）。fail-safe：写失败不影响检索主链路。
registerMigration({ version: 30, name: 'add_long_term_memory_embedding', database: 'main',
  up: `ALTER TABLE long_term_memory ADD COLUMN embedding_json TEXT;`,
  down: `ALTER TABLE long_term_memory DROP COLUMN embedding_json;`,
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

  // --- Memory DB ---
  // v1：**共享记忆 KV 表建立**（FE-034）
  //
  // 背景：`memory_entries` 在代码中**从未创建** —— `GET /api/memory/entries`（记忆视图
  // 数据源）与 `ipc-get-memory-entries` 都查这张表，因表缺失恒为空数组。
  // 现由长时记忆写入/状态变更时镜像投影（key=`ltm-<n>`、namespace='long-term'），
  // 启动回灌时补齐存量条目；表带属主维度（FE-032），读取一律按属主过滤。
  registerMigration({ version: 1, name: 'create_memory_entries', database: 'memory',
    up: `CREATE TABLE IF NOT EXISTS memory_entries (
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      key           TEXT NOT NULL,
      namespace     TEXT NOT NULL DEFAULT 'default',
      value         TEXT NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_ns ON memory_entries(owner_user_id, namespace, updated_at DESC);`,
    down: `DROP INDEX IF EXISTS idx_memory_entries_ns;
    DROP TABLE IF EXISTS memory_entries;`,
  });
}

export function initMigrations(): Result<void> {
  try {
    registerDefaultMigrations();
    // 版本号冲突检测（务必保留）：同一数据库内出现重复 version 时，
    // 后注册的那条会被 `isApplied()` 判定为"已应用"而**静默跳过** —— 迁移没跑、schema 却是旧版，
    // 属于最难察觉的一类故障（曾真实发生：新增 v24 时与既有 v24 撞号，列没建出来只在测试里暴露）。
    const seen = new Map<string, string>();
    for (const m of migrations) {
      const key = `${m.database ?? 'main'}:${m.version}`;
      const prev = seen.get(key);
      if (prev) {
        return err(
          `迁移版本号冲突：${key} 同时被 "${prev}" 与 "${m.name}" 使用（后者将被静默跳过）。请改用新的版本号。`,
          'FATAL',
        );
      }
      seen.set(key, m.name);
    }
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

