-- ============================================================================
-- Civitas-AI 服务端 · A2A 对话消息镜像（P0c）
--
-- 设计：Docs/Dev/A2A-治理型智能体间通信协议设计.md §15
-- 定位：**本机 SQLite 为权威**（含 signature / Broker 判定 / hash 链），服务端只做
--       脱敏后的**镜像 + 跨设备恢复源**；禁止反向覆盖本机的 verdict/prev_hash/signature。
--
-- 刻意不存：
--   - `signature`（Broker 签名是本机治理凭证，服务端不验签 —— Q6）；
--   - 串通告警**证据正文**（只在本机/治理面，避免把"疑似串通"原始证据放服务端）。
-- 脱敏：客户端上传前脱敏；服务端再做一次**防御性扫描**（命中密钥模式即替换并记录字段）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS a2a_messages (
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id        text        NOT NULL,
  task_id           text        NOT NULL,
  trace_id          text        NOT NULL,
  kind              text        NOT NULL,
  source_agent_id   text        NOT NULL,
  target_agent_id   text        NOT NULL,
  parent_message_id text,
  correlation_id    text,
  visibility        text        NOT NULL,
  content_hash      text        NOT NULL,
  prev_hash         text,
  payload_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  summary           text,
  verdict           text        NOT NULL,
  block_reason      text,
  priority          text        NOT NULL DEFAULT 'normal',
  memory_refs_json  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- 脱敏审计：被替换的字段路径（不含原文）
  redacted_fields   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- 载荷超限被截断（保留 content_hash 供本机校验）
  truncated         boolean     NOT NULL DEFAULT false,
  -- 客户端创建时间（epoch ms，离线一致）
  created_at        bigint      NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_user_task
  ON a2a_messages(user_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_user_pair
  ON a2a_messages(user_id, source_agent_id, target_agent_id, created_at DESC);
-- 游标分页（created_at, message_id）
CREATE INDEX IF NOT EXISTS idx_a2a_user_cursor
  ON a2a_messages(user_id, created_at, message_id);

-- 卡片镜像（身份/权限恢复用；本机仍是签发权威）
CREATE TABLE IF NOT EXISTS a2a_agent_cards (
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id           text        NOT NULL,
  agent_id          text        NOT NULL,
  card_version      integer     NOT NULL,
  role              text        NOT NULL,
  create_time       bigint      NOT NULL,
  father_agent_id   text,
  father_role       text,
  lineage_json      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status            text        NOT NULL,
  health_json       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ability_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  permission_json   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  fingerprint       text        NOT NULL,
  expires_at        bigint      NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_cards_agent
  ON a2a_agent_cards(user_id, agent_id, card_version DESC);
