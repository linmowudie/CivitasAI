/**
 * ModelProviderPanel —— 模型供应商管理面板
 *
 * 功能：
 * - 供应商列表（卡片式，显示名称、模型数量）
 * - 添加供应商（选择预置供应商 → 输入 API_KEY → 拉取模型 → 注册）
 * - 移除供应商
 * - 路由配置（defaultModel 等下拉选择）
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, ChevronDown, Check, AlertCircle, Loader2 } from 'lucide-react';
import { useModelStore, PRESET_PROVIDERS } from '@/stores/modelStore';
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

  // 初始化加载
  useEffect(() => {
    fetchProviders();
    fetchRouting();
    fetchModels();
  }, []);

  const currentPreset = PRESET_PROVIDERS.find(p => p.id === selectedPreset);

  // 拉取模型列表
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
    } else {
      setFormError(result.error ?? '拉取模型失败');
    }
  }, [currentPreset, apiKey, fetchProviderModels]);

  // 注册供应商
  const handleAddProvider = useCallback(async () => {
    if (!currentPreset) return;
    setFormError('');
    const result = await addProvider({
      provider: currentPreset.id,
      base_url: currentPreset.base_url,
      api_key: apiKey.trim(),
      display_name: currentPreset.name,
      models: fetchedModels.length > 0 ? fetchedModels : undefined,
    });
    if (result.ok) {
      setShowAddForm(false);
      setSelectedPreset('');
      setApiKey('');
      setFetchedModels([]);
    } else {
      setFormError(result.error ?? '注册失败');
    }
  }, [currentPreset, apiKey, fetchedModels, addProvider]);

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

          {/* 拉取的模型列表 */}
          {fetchedModels.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs text-text-muted">
                拉取到 {fetchedModels.length} 个模型
              </label>
              <div className="max-h-40 overflow-y-auto rounded-lg bg-surface-900/50 border border-surface-700 p-2 space-y-1">
                {fetchedModels.map(m => (
                  <div key={m.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs text-text-secondary">
                    <Check size={12} className="text-emerald-400" />
                    {m.id}
                    <span className="text-text-muted/50 ml-auto">{m.context_window.toLocaleString()} ctx</span>
                  </div>
                ))}
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
              disabled={!currentPreset || !apiKey.trim()}
              className="px-4 py-1.5 rounded-lg bg-brand-500 text-white text-sm font-medium hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              确认添加
            </button>
            <button
              onClick={() => { setShowAddForm(false); setFormError(''); setFetchedModels([]); }}
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
