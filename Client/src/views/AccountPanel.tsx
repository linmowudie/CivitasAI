/**
 * AccountPanel —— 账号与同步面板（客户端接入服务端，Docs/Client/04）。
 *
 * 承载：
 *  ① 服务器地址配置与连通性测试
 *  ② 注册 / 登录 / 登出（本设备 / 全部设备）
 *  ③ 账号信息与登录设备管理
 *  ④ 同步操作：拉取 / 上传 / 导出备份 / 导入恢复（merge|replace）
 *  ⑤ 同步状态：进行中 / 上次同步 / 未同步改动 / 冲突与错误提示
 *
 * 设计约定（Docs/Server/01 §6）：**服务端权威** —— 登录后自动拉取；本地改动需显式上传；
 * 设置写入带 revision 乐观并发，冲突时由用户选择以哪端为准。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, Cloud, CloudDownload, CloudUpload, Download, Loader2,
  LogIn, LogOut, Monitor, RefreshCw, Server, ShieldCheck, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { useAccountStore } from '@/stores/accountStore';
import { usePrefsStore } from '@/stores/prefsStore';

// ── 小工具 ──────────────────────────────────────────────────────────

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Section({ title, icon, children, hint }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; hint?: string;
}) {
  return (
    <div className="p-4 rounded-lg border border-surface-700 bg-surface-800 flex flex-col gap-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {icon}{title}
        </div>
        {hint && <div className="text-[11px] text-text-muted mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'px-2 py-1.5 rounded bg-surface-900 border border-surface-700 text-xs text-text-primary ' +
  'focus:outline-none focus:border-brand-500 disabled:opacity-50';

// ── 主组件 ──────────────────────────────────────────────────────────

export default function AccountPanel() {
  const {
    ready, serverUrl, secureStorage, status, user, sessions, devices, lastError, syncPhase,
    lastPull, lastPush, statsOverview, conflict, pending,
    init, setServerUrl, testConnection, register, login, logout,
    loadSessions, loadDevices, revokeDevice, revokeSession, pull, push, exportBackup, restoreBackup,
    retryPending, clearError,
  } = useAccountStore();
  const { dirty, meta } = usePrefsStore();

  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [probe, setProbe] = useState<string | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDevices, setShowDevices] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void init(); }, [init]);
  useEffect(() => { setUrlDraft(serverUrl); }, [serverUrl]);

  const authenticated = status === 'authenticated';
  const syncing = syncPhase !== 'idle';

  const handleProbe = useCallback(async () => {
    setBusy(true);
    setProbe(null);
    await setServerUrl(urlDraft);
    const result = await testConnection();
    setProbe(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
    setBusy(false);
  }, [urlDraft, setServerUrl, testConnection]);

  const handleAuth = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    clearError();
    const ok = mode === 'login'
      ? await login({ email: email.trim(), password })
      : await register({ email: email.trim(), password, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) });
    setBusy(false);
    setNotice(ok ? '操作成功' : null);
    if (ok) setPassword('');
  }, [mode, email, password, displayName, login, register, clearError]);

  const handleExport = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await exportBackup();
    setBusy(false);
    if (!result.ok || !result.bundle) {
      setNotice(`导出失败：${result.message}`);
      return;
    }
    // 浏览器/Electron 均可用：Blob + <a download> 触发保存
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `civitas-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice('备份包已导出（浏览器下载目录）');
    } catch {
      setNotice('备份包已生成，但下载失败（可改用服务端 /v1/backup/download）');
    }
  }, [exportBackup]);

  const handleImport = useCallback(async (file: File, restoreMode: 'merge' | 'replace') => {
    setBusy(true);
    setNotice(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as unknown;
      const ok = await restoreBackup(bundle, restoreMode);
      setNotice(ok ? `已按 ${restoreMode} 模式恢复，并拉取到本地` : '恢复失败，请查看错误提示');
    } catch (e) {
      setNotice(`备份包解析失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [restoreBackup]);

  if (!ready) {
    return (
      <div className="p-4 text-xs text-text-muted flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />正在初始化账号模块…
      </div>
    );
  }

  return (
    <div data-testid="account-panel" className="flex flex-col gap-3 p-4 overflow-y-auto">
      {/* ① 服务器 */}
      <Section title="服务端" icon={<Server size={14} className="text-brand-400" />}
        hint="自托管的 Civitas 账号与数据服务（默认 http://127.0.0.1:8787）">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="服务器地址">
              <input className={inputCls} value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)}
                placeholder="http://127.0.0.1:8787" disabled={authenticated} />
            </Field>
          </div>
          <button className="btn text-xs" onClick={handleProbe} disabled={busy}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}测试连接
          </button>
        </div>
        {probe && <div className="text-[11px] text-text-secondary">{probe}</div>}
        <div className="text-[10px] text-text-muted">
          令牌存储：{secureStorage
            ? '系统加密存储（Electron safeStorage）'
            : '浏览器模式 · 仅本会话（关闭窗口需重新登录）'}
        </div>
      </Section>

      {/* ② 未登录：登录 / 注册 */}
      {!authenticated && (
        <Section title={mode === 'login' ? '登录账号' : '注册账号'}
          icon={mode === 'login' ? <LogIn size={14} className="text-brand-400" /> : <UserPlus size={14} className="text-brand-400" />}
          hint="登录可选：不登录时应用仍可完全本地使用；登录后数据可跨设备/重装恢复">
          <div className="grid grid-cols-2 gap-2">
            <Field label="邮箱">
              <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com" autoComplete="username" />
            </Field>
            <Field label="密码（至少 8 位，含字母与数字）">
              <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </Field>
            {mode === 'register' && (
              <Field label="显示名（可选）">
                <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="例如：张三" />
              </Field>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary text-xs" onClick={handleAuth}
              disabled={busy || !email.trim() || !password}>
              {busy && <Loader2 size={12} className="animate-spin" />}
              {mode === 'login' ? '登录' : '注册并登录'}
            </button>
            <button className="btn text-xs" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setNotice(null); clearError(); }}>
              {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
            </button>
          </div>
        </Section>
      )}

      {/* ③ 已登录：账号信息 */}
      {authenticated && user && (
        <Section title="账号信息" icon={<ShieldCheck size={14} className="text-success" />}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div className="text-text-muted">邮箱</div><div className="text-text-primary">{user.email}</div>
            <div className="text-text-muted">显示名</div><div className="text-text-primary">{user.displayName ?? '—'}</div>
            <div className="text-text-muted">注册时间</div><div className="text-text-secondary">{formatIso(user.createdAt)}</div>
            <div className="text-text-muted">上次登录</div><div className="text-text-secondary">{formatIso(user.lastLoginAt)}</div>
            <div className="text-text-muted">状态</div><div className="text-text-secondary">{user.status}</div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button className="btn text-xs" onClick={() => void logout(false)}>
              <LogOut size={12} />登出本设备
            </button>
            <button className="btn btn-danger text-xs" onClick={() => void logout(true)}>
              <LogOut size={12} />登出全部设备
            </button>
            <button className="btn text-xs" onClick={() => { setShowDevices((v) => !v); if (!showDevices) { void loadSessions(); void loadDevices(); } }}>
              <Monitor size={12} />登录设备
              <ChevronDown size={12} className={showDevices ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            <button className="btn text-xs ml-auto" onClick={handleExport} disabled={busy}>
              <Download size={12} />导出备份
            </button>
          </div>
          {showDevices && (
            <div className="flex flex-col gap-2 pt-1">
              {/* 设备（安装凭据）：严格设备模式下的解绑入口；换机/重装后在此移除旧设备 */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] text-text-muted">设备（安装凭据）· 移除后可在新设备登录</div>
                {devices.length === 0 && <div className="text-[11px] text-text-muted">暂无已登记设备</div>}
                {devices.map((d) => (
                  <div key={d.deviceId} className="flex items-center gap-2 text-[11px] px-2 py-1.5 rounded bg-surface-900">
                    <Monitor size={12} className="text-text-muted" />
                    <span className="text-text-secondary truncate max-w-[180px]" title={d.deviceId}>{d.label ?? d.deviceId}</span>
                    <span className="text-text-muted font-mono">
                      {d.kind === 'install' ? '安装凭据' : '旧指纹'}
                      {d.lastSeenAt ? ` · 最近 ${formatIso(d.lastSeenAt)}` : ''}
                    </span>
                    <span className="text-text-muted font-mono ml-auto">{d.ip ?? ''}</span>
                    <button className="btn text-[10px] py-0.5 px-1.5" title="移除该设备（解绑）"
                      onClick={() => void revokeDevice(d.deviceId)}>
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
              {/* 会话（刷新令牌家族）：吊销即让该设备的登录态失效 */}
              <div className="flex flex-col gap-1.5">
                <div className="text-[11px] text-text-muted">会话（登录凭证）</div>
                {sessions.length === 0 && <div className="text-[11px] text-text-muted">暂无活跃会话</div>}
                {sessions.map((s) => (
                  <div key={s.sessionId} className="flex items-center gap-2 text-[11px] px-2 py-1.5 rounded bg-surface-900">
                    <Monitor size={12} className="text-text-muted" />
                    <span className="text-text-secondary truncate">{s.deviceLabel ?? '未命名设备'}</span>
                    <span className="text-text-muted font-mono">登录于 {formatIso(s.issuedAt)}</span>
                    <span className="text-text-muted font-mono ml-auto">{s.ip ?? ''}</span>
                    <button className="btn text-[10px] py-0.5 px-1.5" title="吊销该会话"
                      onClick={() => void revokeSession(s.sessionId)}>
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ④ 同步 */}
      {authenticated && (
        <Section title="数据同步" icon={<Cloud size={14} className="text-brand-400" />}
          hint="服务端为权威源：登录后自动拉取；本地改动需上传（记忆与统计按幂等键去重）">
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn btn-primary text-xs" onClick={() => void pull()} disabled={syncing}>
              {syncPhase === 'pulling' ? <Loader2 size={12} className="animate-spin" /> : <CloudDownload size={12} />}
              从云端拉取
            </button>
            <button className="btn btn-success text-xs" onClick={() => void push(false)} disabled={syncing}>
              {syncPhase === 'pushing' ? <Loader2 size={12} className="animate-spin" /> : <CloudUpload size={12} />}
              上传到云端
            </button>
            <button className="btn text-xs" onClick={() => fileRef.current?.click()} disabled={busy || syncing}>
              <Upload size={12} />导入备份包
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const replace = globalThis.confirm('恢复模式选择：\n\n【确定】= replace（清空云端该账号数据后重建）\n【取消】= merge（按记忆 ID 合并，不删除）');
                  void handleImport(file, replace ? 'replace' : 'merge');
                }
              }} />
            {pending.length > 0 && (
              <button className="btn text-xs" onClick={() => void retryPending()} disabled={syncing}>
                <RefreshCw size={12} />重试 {pending.length} 项
              </button>
            )}
          </div>

          {/* 状态行 */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] pt-1">
            <div className="text-text-muted">上次拉取</div><div className="text-text-secondary">{formatTime(meta.lastPullAt)}</div>
            <div className="text-text-muted">上次上传</div><div className="text-text-secondary">{formatTime(meta.lastPushAt)}</div>
            <div className="text-text-muted">未上传改动</div>
            <div className={dirty ? 'text-warning' : 'text-text-secondary'}>{dirty ? '有（偏好设置）' : '无'}</div>
            {lastPull && (
              <>
                <div className="text-text-muted">拉取结果</div>
                <div className="text-text-secondary">
                  设置 rev {lastPull.settings.revision} · 记忆 {lastPull.memories.imported} 新增 / {lastPull.memories.updated} 更新
                </div>
              </>
            )}
            {lastPush && (
              <>
                <div className="text-text-muted">上传结果</div>
                <div className="text-text-secondary">
                  记忆 {lastPush.memories.created} 新增 / {lastPush.memories.updated} 更新 · 统计 {lastPush.stats.accepted} 条入库
                </div>
              </>
            )}
          </div>

          {/* 统计概览 */}
          {statsOverview && (
            <div className="pt-1">
              <div className="text-[11px] text-text-muted mb-1">云端统计概览</div>
              <div className="flex items-center gap-3 text-[11px] text-text-secondary flex-wrap">
                <span>累计事件 <b className="text-text-primary">{statsOverview.lifetime.events}</b></span>
                <span>累计数值 <b className="text-text-primary">{statsOverview.lifetime.value}</b></span>
                <span>活跃天数 <b className="text-text-primary">{statsOverview.lifetime.activeDays}</b></span>
                <span>云端记忆 <b className="text-text-primary">{statsOverview.memories.total}</b></span>
                <span>活跃设备 <b className="text-text-primary">{statsOverview.sessions.active}</b></span>
              </div>
            </div>
          )}

          {/* 冲突 */}
          {conflict && (
            <div className="p-2 rounded border border-warning/40 bg-warning/10 text-[11px] text-warning flex items-center gap-2">
              <AlertTriangle size={12} />
              云端设置已被其他设备修改（云端版本 {conflict.currentRevision}）。
              <button className="btn text-[10px] py-0.5 px-1.5" onClick={() => void pull()}>以云端为准</button>
              <button className="btn text-[10px] py-0.5 px-1.5" onClick={() => void push(true)}>以本机为准</button>
            </div>
          )}
        </Section>
      )}

      {/* ⑤ 提示 */}
      {(lastError || notice) && (
        <div className={`p-3 rounded-lg border text-[11px] flex items-start gap-2 ${
          lastError ? 'border-danger/40 bg-danger/10 text-danger' : 'border-surface-700 bg-surface-800 text-text-secondary'
        }`}>
          {lastError ? <AlertTriangle size={12} className="mt-0.5" /> : <Check size={12} className="mt-0.5 text-success" />}
          <span className="flex-1 whitespace-pre-wrap">{lastError ?? notice}</span>
          {lastError && <button className="btn text-[10px] py-0.5 px-1.5" onClick={clearError}>知道了</button>}
        </div>
      )}

      <div className="text-[10px] text-text-muted">
        说明：需要跨设备/重装保留的数据（偏好设置、长时记忆、统计）保存在服务端；
        会话消息与工具轨迹仍只在本机。删除软件后重新安装，用同一账号登录即可恢复。
      </div>
    </div>
  );
}
