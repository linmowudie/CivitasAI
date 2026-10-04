/**
 * @module views/Auth/LoginPage
 * @description
 * 验证码登录页面（账号唯一真源 `accountStore`，FE-031 合并）。
 * 
 * 流程：
 *  1. 输入邮箱 → 发送验证码（accountStore.sendCode）
 *  2. 输入验证码 → 登录/自动注册（accountStore.loginWithCode；成功后自动拉取云端数据）
 *  3. 登录成功 → 跳转到主界面
 * 
 * 开发环境：
 *  - 显示提示：验证码由服务端随机生成（devCode 回传后显示在此）
 *  - 开发测试账号：dev@civitas.local
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccountStore } from '@/stores/accountStore';

/** 判断是否为开发环境 */
function isDevEnv(): boolean {
  try {
    return import.meta.env?.DEV ?? false;
  } catch {
    return false;
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const {
    loginPhase,
    loginEmail,
    devCode,
    lastError: error,
    sendCode,
    loginWithCode,
    clearError,
    resetLoginFlow,
  } = useAccountStore();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [loading, setLoading] = useState(false);

  // 验证码倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // 登录成功后跳转（云端拉取已在 loginWithCode 内自动触发，无需在此等待）
  useEffect(() => {
    if (loginPhase === 'authenticated') {
      navigate('/chat', { replace: true });
    }
  }, [loginPhase, navigate]);

  const handleSendCode = useCallback(async () => {
    if (!email.trim()) return;
    setLoading(true);
    clearError();
    const ok = await sendCode(email.trim());
    setLoading(false);
    if (ok) {
      setCountdown(useAccountStore.getState().codeExpiresIn || 300);
    }
  }, [email, sendCode, clearError]);

  const handleLogin = useCallback(async () => {
    if (!code.trim()) return;
    setLoading(true);
    clearError();
    await loginWithCode(email.trim(), code.trim(), displayName.trim() || undefined);
    setLoading(false);
  }, [email, code, displayName, loginWithCode, clearError]);

  const handleBack = useCallback(() => {
    resetLoginFlow();
    setCode('');
    setDisplayName('');
  }, [resetLoginFlow]);

  const dev = isDevEnv();

  return (
    <div className="flex h-full items-center justify-center bg-surface-950">
      <div className="w-full max-w-md p-8">
        {/* Logo / 标题 */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-surface-100">Civitas AI</h1>
          <p className="mt-2 text-sm text-surface-400">智能助手工作台</p>
        </div>

        {/* 开发环境提示 */}
        {dev && (
          <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
            <p className="font-medium">🔧 开发环境</p>
            <p className="mt-1">测试账号：dev@civitas.local</p>
            {devCode
              ? <p>当前验证码：<span className="font-mono font-bold">{devCode}</span></p>
              : <p>输入邮箱并点击「发送验证码」后，本次验证码会显示在这里（服务端随机生成，<span className="font-mono">无固定码</span>）</p>}
          </div>
        )}

        {/* 主卡片 */}
        <div className="rounded-xl border border-surface-700 bg-surface-900 p-6 shadow-xl">
          {loginPhase === 'idle' || loginPhase === 'sending_code' ? (
            /* ── 步骤 1：输入邮箱 ── */
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-surface-100">邮箱登录</h2>
              <p className="text-sm text-surface-400">
                输入邮箱地址，我们将发送验证码到您的邮箱
              </p>

              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-surface-300">
                  邮箱地址
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full rounded-lg border border-surface-600 bg-surface-800 px-4 py-2.5 text-surface-100 placeholder-surface-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleSendCode()}
                  disabled={loading}
                />
              </div>

              {error && (
                <p className="text-sm text-red-400">{error}</p>
              )}

              <button
                onClick={handleSendCode}
                disabled={loading || !email.trim()}
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? '发送中...' : '发送验证码'}
              </button>
            </div>
          ) : loginPhase === 'code_sent' || loginPhase === 'verifying' ? (
            /* ── 步骤 2：输入验证码 ── */
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-surface-100">输入验证码</h2>
              <p className="text-sm text-surface-400">
                验证码已发送到 <span className="font-medium text-surface-200">{loginEmail}</span>
              </p>

              <div>
                <label htmlFor="code" className="mb-1 block text-sm font-medium text-surface-300">
                  验证码（6位数字）
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="w-full rounded-lg border border-surface-600 bg-surface-800 px-4 py-2.5 text-center font-mono text-2xl tracking-widest text-surface-100 placeholder-surface-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  disabled={loading}
                  autoFocus
                />
              </div>

              {/* 新注册用户可选填显示名称 */}
              <div>
                <label htmlFor="displayName" className="mb-1 block text-sm font-medium text-surface-300">
                  显示名称（可选，首次登录时设置）
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="你的名字"
                  className="w-full rounded-lg border border-surface-600 bg-surface-800 px-4 py-2.5 text-surface-100 placeholder-surface-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                  disabled={loading}
                />
              </div>

              {error && (
                <p className="text-sm text-red-400">{error}</p>
              )}

              <button
                onClick={handleLogin}
                disabled={loading || code.length !== 6}
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? '验证中...' : '登录'}
              </button>

              {/* 重新发送 & 返回 */}
              <div className="flex items-center justify-between text-sm">
                <button
                  onClick={handleBack}
                  className="text-surface-400 hover:text-surface-200"
                >
                  ← 更换邮箱
                </button>
                <button
                  onClick={handleSendCode}
                  disabled={countdown > 0}
                  className="text-brand-400 hover:text-brand-300 disabled:text-surface-600"
                >
                  {countdown > 0 ? `重新发送 (${countdown}s)` : '重新发送'}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 底部信息 */}
        <p className="mt-6 text-center text-xs text-surface-500">
          登录即表示同意服务条款和隐私政策
        </p>
      </div>
    </div>
  );
}
