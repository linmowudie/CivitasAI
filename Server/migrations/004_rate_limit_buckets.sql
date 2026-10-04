-- ============================================================================
-- Civitas-AI 服务端 · 限流共享存储（SV-003）
--
-- 背景：原限流是**进程内计数**，多实例部署时每个实例各算一份 →
-- 实际阈值 = 配置值 × 实例数（暴力破解防护被稀释）。
--
-- 方案：把计数放进 PostgreSQL（本服务已依赖 PG，无需引入 Redis），
-- 用单条原子 UPSERT 实现固定窗口计数，多实例共享同一份计数。
-- 由配置 `RATE_LIMIT_STORE=postgres` 启用（生产默认启用）。
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key   text        PRIMARY KEY,
  window_start timestamptz NOT NULL,
  used         integer     NOT NULL
);

-- 过期桶清理用
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_buckets (window_start);

COMMENT ON TABLE rate_limit_buckets IS '限流计数（固定窗口，多实例共享；由 RATE_LIMIT_STORE=postgres 启用）';
