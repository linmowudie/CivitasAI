-- ============================================================================
-- Civitas-AI 服务端 · 验证码认证 + 设备绑定
-- 
-- 新增功能：
--  - 邮箱验证码登录（5分钟有效期）
--  - 设备绑定（防止开发账号被其他设备登录）
-- ============================================================================

-- ── 验证码存储 ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_lower text        NOT NULL,
  code        text        NOT NULL,
  -- 用途：register（注册）/ login（登录）/ reset_password（重置密码）
  purpose     text        NOT NULL DEFAULT 'login',
  -- 过期时间（默认5分钟）
  expires_at  timestamptz NOT NULL,
  -- 使用后标记，防止重复使用
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_codes_purpose_check CHECK (purpose IN ('register', 'login', 'reset_password'))
);

-- 查询索引：按邮箱+用途+未过期+未使用
CREATE INDEX IF NOT EXISTS verification_codes_lookup_idx
  ON verification_codes (email_lower, purpose, expires_at DESC)
  WHERE used_at IS NULL;

-- 自动清理过期验证码的索引
CREATE INDEX IF NOT EXISTS verification_codes_expiry_idx
  ON verification_codes (expires_at)
  WHERE used_at IS NULL;

-- ── 设备绑定 ────────────────────────────────────────────────────────────────

-- users 表添加设备绑定字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS bound_device_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_bound_at timestamptz;

-- 设备绑定信息表（记录所有绑定过的设备，用于审计）
CREATE TABLE IF NOT EXISTS user_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   text        NOT NULL,
  device_label text,
  user_agent  text,
  ip          inet,
  -- 是否当前绑定的主设备
  is_primary  boolean     NOT NULL DEFAULT false,
  bound_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS user_devices_user_idx ON user_devices (user_id);
CREATE INDEX IF NOT EXISTS user_devices_device_idx ON user_devices (device_id);
