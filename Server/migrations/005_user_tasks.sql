-- ============================================================================
-- Civitas-AI 服务端 · 任务（会话）元数据
--
-- 背景：任务/会话的**正文**只保存在本机（含工具轨迹），但"有哪些任务、标题是什么、
-- 是否已归档"属于需要跨设备/重装恢复的**个人数据**。
-- 因此服务端只存**元数据**（不含消息内容），由客户端上行并在重装后拉回。
--
-- 说明：owner 与任务以 (user_id, client_session_id) 唯一；归档用 archived_at 表示
--（NULL = 未归档），同时保留 created_at/updated_at 供排序与保留策略使用。
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_tasks (
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_session_id text        NOT NULL,
  title             text        NOT NULL DEFAULT '',
  -- 本机创建时间（epoch ms，由客户端提供，便于离线创建后保持一致）
  created_at        bigint      NOT NULL,
  updated_at        bigint      NOT NULL,
  -- 归档时间（epoch ms）；NULL = 未归档
  archived_at       bigint,
  -- 服务端记录的最后同步时间（用于审计与增量拉取）
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_session_id)
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_owner ON user_tasks (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_tasks_archived ON user_tasks (user_id, archived_at);

COMMENT ON TABLE user_tasks IS '任务（会话）元数据：标题 + 归档状态；正文只存本机';
