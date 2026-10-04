-- ============================================================================
-- Civitas-AI 服务端 · 认证加固（2026-10-02）
--
-- 背景（安全审计 SV-012 / SV-013 / SV-014）：
--  ① 验证码曾【明文落库】且用 Math.random() 生成 —— 改为哈希存储 + CSPRNG + 失败锁定
--  ② 设备绑定曾以"易变硬件指纹"做硬绑定（换 Wi-Fi/VPN/主机名即被拒，且无解绑通路）
--     —— 改为"设备凭据 + 可管理设备列表"，硬绑定退化为可选模式
-- ============================================================================

-- ── 验证码加固 ──────────────────────────────────────────────────────────────

-- 只存哈希（sha256），明文不再落库
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS code_hash text;
-- 失败尝试计数（达到上限即作废，防 6 位码爆破）
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
-- 明文列移除（历史数据无保留价值；新代码只写 code_hash）
ALTER TABLE verification_codes DROP COLUMN IF EXISTS code;

-- 按邮箱+用途查最近签发时间（用于发送配额与冷却）
CREATE INDEX IF NOT EXISTS verification_codes_email_recent_idx
  ON verification_codes (email_lower, purpose, created_at DESC);

-- ── 设备管理加固 ────────────────────────────────────────────────────────────

-- 设备凭据（安装期生成的随机串哈希；不再依赖易变硬件指纹）
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS credential_hash text;
-- 设备类型：install（安装期凭据）/ legacy（旧硬件指纹）/ manual
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS device_kind text NOT NULL DEFAULT 'install';
-- 最近活跃时间（设备列表展示与清理）
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS user_devices_credential_idx
  ON user_devices (credential_hash)
  WHERE credential_hash IS NOT NULL;

-- 说明：users.bound_device_id 保留仅为兼容与展示，
-- 是否"硬拒绝新设备"改由配置 security.deviceBindingMode（off|warn|strict，默认 warn）决定。
COMMENT ON COLUMN users.bound_device_id IS '兼容字段：首次登录设备（展示用）。硬绑定行为见 security.deviceBindingMode';
