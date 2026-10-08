/**
 * ModelProviderPanel —— 模型供应商管理面板
 *
 * 功能：
 * - 供应商列表（卡片式，显示名称、模型数量）
 * - 添加供应商（选择预置供应商 → 输入 API_KEY → 拉取模型 → **逐个校验可用性** → **用户勾选** → 注册）
 * - 移除供应商
 * - 路由配置（defaultModel 等下拉选择）
 *
 * 模型导入重设计（2026-10-07）：
 * - `/models` 只代表"账号可见"，未开通/无权限的模型也在列表里（实测 262 个）；
 * - 因此：拉列表 → 逐个最小对话请求确认可用 → **只导入用户勾选的模型**（绝不默认全选）。
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, RefreshCw, ChevronDown, Check, Circle, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { useModelStore, PRESET_PROVIDERS } from '@/stores/modelStore';
import { ipcVerifyModels, type ModelVerificationDto } from '@/services/ipcApi';
import type { ModelSpec, RoutingConfig } from '@/stores/modelStore';

export default function ModelProviderPanel() {
  const {
    providers, routingConfig, availableModels, loading, error,
    fetchProviders, fetchRouting, fetchModels,
    addProvider, removeProvider, fetchProviderModels, updateRouting,
  } = useModelStore();

  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<ModelSpec[]>([]);
  const [formError, setFormError] = useState('');
  /** 用户勾选要导入的模型（默认**空**：不自动全选） */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 逐模型可用性校验结果 */
  const [availability, setAvailability] = useState<Record<string, ModelVerificationDto>>({});
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState({ checked: 0, total: 0 });

  // 初始化加载
  useEffect(() => {
    fetchProviders();
    fetchRouting();
    fetchModels();
  }, []);

  const currentPreset = PRESET_PROVIDERS.find(p => p.id === selectedPreset);

  // 拉取模型列表（拉取后：清空勾选与校验结果——绝不默认全选）
  const handleFetchModels = useCallback(async () => {
    if (!currentPreset || !apiKey.trim()) {
      setFormError('请先选择供应商并输入 API Key');
      return;
    }
    setFetchingModels(true);
    setFormError('');
    const result = await fetchProviderModels(currentPreset.base_url, apiKey.trim());
    setFetchingModels(false);
    if (result.ok && result.data) {
      setFetchedModels(result.data);
      setSelectedIds(new Set());
      setAvailability({});
    } else {
      setFormError(result.error ?? '拉取模型失败');
    }
  }, [currentPreset, apiKey, fetchProviderModels]);

  /** 切换单个模型的勾选 */
  const toggleModel = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  /**
   * 逐个校验可用性（小批次调用后端，显示进度）。
   * 只校验不导入；是否导入由用户勾选决定。
   */
  const handleVerifyModels = useCallback(async () => {
    if (!currentPreset || !apiKey.trim() || fetchedModels.length === 0) {
      setFormError('请先"测试并拉取模型"');
      return;
    }
    const all = fetchedModels.map(m => m.id);
    const BATCH = 8;
    setVerifying(true);
    setFormError('');
    setVerifyProgress({ checked: 0, total: all.length });

    let checked = 0;
    const next: Record<string, ModelVerificationDto> = {};
    for (let i = 0; i < all.length; i += BATCH) {
      const res = await ipcVerifyModels({
        base_url: currentPreset.base_url,
        api_key: apiKey.trim(),
        models: all.slice(i, i + BATCH),
      });
      if (!res.ok || !res.data) {
        setVerifying(false);
        setFormError(res.error ?? '可用性校验失败');
        return;
      }
      for (const item of res.data.results) next[item.id] = item;
      checked += res.data.results.length;
      setAvailability({ ...next });
      setVerifyProgress({ checked, total: all.length });
    }

    setVerifying(false);
    const available = all.filter(id => next[id]?.status === 'available').length;
    const unavailable = all.filter(id => next[id]?.status === 'unavailable').length;
    const unknown = all.filter(id => next[id]?.status === 'unknown').length;
    setFormError(`可用性校验完成：可用 ${available} / 不可用 ${unavailable} / 未知 ${unknown}（未知多为限流或超时，可重试；不可用悬停可看原因）`);
  }, [currentPreset, apiKey, fetchedModels]);

  /** 仅勾选校验为可用的模型 */
  const selectOnlyAvailable = useCallback(() => {
    setSelectedIds(new Set(fetchedModels
      .filter(m => availability[m.id]?.status === 'available')
      .map(m => m.id)));
  }, [fetchedModels, availability]);

  const availableCount = useMemo(
    () => fetchedModels.filter(m => availability[m.id]?.status === 'available').length,
    [fetchedModels, availability],
  );

  // 注册供应商（**只提交用户勾选的模型**）
  const handleAddProvider = useCallback(async () => {
    if (!currentPreset) return;
    setFormError('');
    const picked = fetchedModels.filter(m => selectedIds.has(m.id));
    if (fetchedModels.length > 0 && picked.length === 0) {
      setFormError('请在列表里勾选要导入的模型（可先"校验可用性"再点"仅选可用"）');
      return;
    }
    const result = await addProvider({
      provider: currentPreset.id,
      base_url: currentPreset.base_url,
      api_key: apiKey.trim(),
      display_name: currentPreset.name,
      models: picked.length > 0 ? picked : undefined,
    });
    if (result.ok) {
      setShowAddForm(false);
      setSelectedPreset('');
      setApiKey('');
      setFetchedModels([]);
      setSelectedIds(new Set());
      setAvailability({});
    } else {
      setFormError(result.error ?? '注册失败');
    }
  }, [currentPreset, apiKey, fetchedModels, selectedIds, addProvider]);

  // 移除供应商
  const handleRemoveProvider = useCallback(async (name: string) => {
    await removeProvider(name);
  }, [removeProvider]);

  // 更新路由配置
  const handleRoutingChange = useCallback(async (field: keyof RoutingConfig, value: any) => {
    await updateRouting({ [field]: value } as Partial<RoutingConfig>);
  }, [updateRouting]);

  return (
    <div className="space-y-6">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">模型供应商</h2>
          <p className="text-sm text-text-muted mt-1">管理 LLM 供应商、API Key 与模型路由</p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          <Plus size={14} />
          添加供应商
        </button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* 添加供应商表单 */}
      {showAddForm && (
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-4">
          <h3 className="text-sm font-medium text-text-primary">添加新供应商</h3>

          {/* 供应商选择 */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">选择供应商</label>
            <div className="relative">
              <select
                value={selectedPreset}
                onChange={e => { setSelectedPreset(e.target.value); setFetchedModels([]); setFormError(''); }}
                className="w-full px-3 py-2 rounded-lg bg-surface-700 border border-surface-600 text-text-primary text-sm outline-none focus:border-brand-500 appearance-none"
              >
                <option value="">-- 选择供应商 --</option>
                {PRESET_PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
            {currentPreset && (
              <p className="text-xs text-text-muted">API 地址：{currentPreset.base_url}</p>
            )}
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="text-xs text-text-muted">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="输入 API Key..."
              className="w-full px-3 py-2 rounded-lg bg-surface-700 border border-surface-600 text-text-primary text-sm outline-none focus:border-brand-500 placeholder:text-text-muted/50"
            />
            <p className="text-xs text-text-muted/60">API Key 仅在运行时内存中保存，重启后需重新输入</p>
          </div>

          {/* 拉取模型按钮 */}
          <button
            onClick={handleFetchModels}
            disabled={fetchingModels || !currentPreset || !apiKey.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-600 text-text-primary text-sm hover:bg-surface-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {fetchingModels ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {fetchingModels ? '拉取中...' : '测试并拉取模型'}
          </button>

          {/* 拉取的模型列表：逐个校验 + 用户勾选（默认不选任何模型） */}
          {fetchedModels.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs text-text-muted">
                  拉取到 {fetchedModels.length} 个模型 · 已勾选 <b className="text-text-primary">{selectedIds.size}</b>
                </label>
                <button
                  type="button"
                  onClick={handleVerifyModels}
                  disabled={verifying}
                  className="flex items-center gap-1 px-2 py-1 rounded bg-surface-600 text-text-primary text-xs hover:bg-surface-500 disabled:opacity-40 transition-colors"
                >
                  {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  {verifying ? `校验中 ${verifyProgress.checked}/${verifyProgress.total}` : '校验可用性（逐个探测）'}
                </button>
                <button
                  type="button"
                  onClick={selectOnlyAvailable}
                  disabled={verifying || availableCount === 0}
                  className="px-2 py-1 rounded bg-surface-600 text-text-primary text-xs hover:bg-surface-500 disabled:opacity-40 transition-colors"
                >
                  仅选可用（{availableCount}）
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={selectedIds.size === 0}
                  className="px-2 py-1 rounded bg-surface-600 text-text-secondary text-xs hover:bg-surface-500 disabled:opacity-40 transition-colors"
                >
                  清空勾选
                </button>
              </div>
              <p className="text-[11px] text-text-muted/70">
                <b>列表可见 ≠ 当前可用</b>：`/models` 会列出账号可见但未开通/无权限的模型。
                <b>只会添加你勾选的模型</b>，不会全量导入。
              </p>

              <div className="max-h-56 overflow-y-auto rounded-lg bg-surface-900/50 border border-surface-700 p-2 space-y-1">
                {fetchedModels.map(m => {
                  const on = selectedIds.has(m.id);
                  const detail = availability[m.id];
                  const badge = detail?.status === 'available'
                    ? { text: '可用', cls: 'text-emerald-400' }
                    : detail?.status === 'unavailable'
                      ? { text: '不可用', cls: 'text-red-400' }
                      : detail?.status === 'unknown'
                        ? { text: '未知', cls: 'text-amber-400' }
                        : { text: '未检测', cls: 'text-text-muted/50' };
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => toggleModel(m.id)}
                      title={detail?.providerMessage ?? '点击勾选 / 取消勾选'}
                      className={`w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left transition-colors ${
                        on ? 'bg-brand-500/15 text-text-primary' : 'text-text-secondary hover:bg-surface-800'
                      }`}
                    >
                      {on
                        ? <Check size={12} className="text-brand-400 shrink-0" />
                        : <Circle size={12} className="text-text-muted/40 shrink-0" />}
                      <span className="truncate">{m.id}</span>
                      <span className={`ml-auto shrink-0 ${badge.cls}`}>{badge.text}</span>
                      {detail?.latencyMs != null && (
                        <span className="text-text-muted/50 shrink-0">{detail.latencyMs}ms</span>
                      )}
                      <span className="text-text-muted/50 shrink-0">{m.context_window.toLocaleString()} ctx</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 表单错误 */}
          {formError && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertCircle size={12} />
              {formError}
            </div>
          )}

          {/* 确认添加 */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleAddProvider}
              disabled={!currentPreset || !apiKey.trim() || (fetchedModels.length > 0 && selectedIds.size === 0)}
              className="px-4 py-1.5 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              确认添加{fetchedModels.length > 0 ? `（${selectedIds.size} 个模型）` : ''}
            </button>
            <button
              onClick={() => {
                setShowAddForm(false);
                setFormError('');
                setFetchedModels([]);
                setSelectedIds(new Set());
                setAvailability({});
              }}
              className="px-4 py-1.5 rounded-lg bg-surface-600 text-text-secondary text-sm hover:bg-surface-500 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 供应商列表 */}
      <div className="space-y-3">
        {providers.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">
            暂无供应商，点击上方「添加供应商」开始配置
          </div>
        ) : (
          providers.map(p => (
            <div key={p.name} className="rounded-xl border border-surface-700 bg-surface-800/50 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-text-primary">{p.displayName}</h4>
                  <p className="text-xs text-text-muted mt-0.5">{p.name} · {p.models.length} 个模型</p>
                </div>
                <button
                  onClick={() => handleRemoveProvider(p.name)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                  title="移除供应商"
                >
                  <Trash2 size={12} />
                  移除
                </button>
              </div>
              {p.models.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.models.map(m => (
                    <span key={m.id} className="px-2 py-0.5 rounded-md bg-surface-700 text-xs text-text-secondary">
                      {m.id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 路由配置 */}
      {routingConfig && (
        <div className="rounded-xl border border-surface-700 bg-surface-800/50 p-4 space-y-4">
          <h3 className="text-sm font-medium text-text-primary">路由配置</h3>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['defaultModel', '默认模型'],
              ['workerModel', 'Worker 模型'],
              ['directorModel', 'Director 模型'],
              ['verifierModel', 'Verifier 模型'],
            ] as [keyof RoutingConfig, string][]).map(([field, label]) => (
              <div key={field} className="space-y-1">
                <label className="text-xs text-text-muted">{label}</label>
                <select
                  value={(routingConfig[field] as string) ?? ''}
                  onChange={e => handleRoutingChange(field, e.target.value)}
                  className="w-full px-2 py-1.5 rounded-lg bg-surface-700 border border-surface-600 text-text-primary text-xs outline-none focus:border-brand-500 appearance-none"
                >
                  <option value="">-- 选择模型 --</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
