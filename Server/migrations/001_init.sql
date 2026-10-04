-- ============================================================================
-- Civitas-AI 服务端 · 初始表结构
-- 目标：账户登录 / 设置管理 / 个人数据统计 / 记忆存储 / 备份恢复
--
-- 约定：
--  - 不依赖任何扩展（citext / pgcrypto 均不需要）：邮箱唯一性走 email_lower，
--    主键用 PG13+ 内置的 gen_random_uuid()
--  - 所有时间列使用 timestamptz（UTC 存储，展示时按 STATS_TIMEZONE 分日）
--  - 用户数据一律带 user_id，并开 ON DELETE CASCADE：注销账号即彻底删除
-- ============================================================================

-- ── 账户 ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text        NOT NULL,
  -- 规范化（trim + 小写）后的邮箱，唯一索引建在它上面
  email_lower         text        NOT NULL UNIQUE,
  password_hash       text        NOT NULL,
  display_name        text,
  status              text        NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);

-- 刷新令牌：只存哈希；按"家族"轮换，检测到重用即吊销整族
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     text        NOT NULL UNIQUE,
  family_id      uuid        NOT NULL,
  device_label   text,
  user_agent     text,
  ip             inet,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  rotated_to     uuid
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- ── 设置管理（服务端为权威源，带修订号做乐观并发）────────────────────────────

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision   bigint      NOT NULL DEFAULT 1,
  data       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 个人数据统计（客户端上报事件，服务端聚合）────────────────────────────────

CREATE TABLE IF NOT EXISTS usage_events (
  id              bigserial PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text        NOT NULL,
  value           numeric     NOT NULL DEFAULT 0,
  occurred_at     timestamptz NOT NULL,
  meta            jsonb,
  client_event_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 幂等：同一用户同一 client_event_id 只记一次（未提供时允许多条 NULL）
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_client_idem_idx
  ON usage_events (user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_events_user_time_idx ON usage_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_user_kind_idx ON usage_events (user_id, kind);

-- ── 记忆存储（与端侧 long_term_memory 字段对齐，便于无损重建）────────────────

CREATE TABLE IF NOT EXISTS memories (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 端侧 memory_id：重装恢复/重复上传时据此幂等 upsert
  client_memory_id        text,
  title                   text        NOT NULL,
  content                 text        NOT NULL,
  category                text        NOT NULL DEFAULT 'general',
  assertion               text        NOT NULL DEFAULT 'observed',
  source_trace_ids        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  source_arbitration_ids  jsonb,
  status                  text        NOT NULL DEFAULT 'active',
  contradicted_by         text,
  access_count            integer     NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL,
  last_accessed_at        timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memories_status_check CHECK (status IN ('active', 'archived', 'deleted')),
  CONSTRAINT memories_assertion_check CHECK (assertion IN ('observed', 'inferred', 'verified', 'disputed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_client_idem_idx
  ON memories (user_id, client_memory_id)
  WHERE client_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS memories_user_time_idx     ON memories (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memories_user_category_idx ON memories (user_id, category);
CREATE INDEX IF NOT EXISTS memories_user_status_idx   ON memories (user_id, status);
-- 全文检索（'simple' 配置无中文分词，中文查询走 ILIKE 兜底，见 memoryRepository）
CREATE INDEX IF NOT EXISTS memories_fts_idx
  ON memories USING gin (to_tsvector('simple', title || ' ' || content));

-- ── 审计日志（登录/改密/令牌重用等安全事件）─────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid,
  action     text        NOT NULL,
  outcome    text        NOT NULL,
  ip         inet,
  user_agent text,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_log_user_time_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx    ON audit_log (action, created_at DESC);
