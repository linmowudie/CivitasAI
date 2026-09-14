/**
 * SystemConfig — 系统配置只读视图。
 * 读取 Configs/ 目录下的 JSON 配置文件，展示配置内容。
 * 写操作留待后续。
 *
 * 数据源：GET /api/configs + GET /api/configs/:name
 */
import { useState, useEffect } from 'react';
import { Settings, FileJson } from 'lucide-react';
import { apiGet } from '@/services/api';

interface ConfigFile {
  name: string;
  size: number;
}

export default function SystemConfig() {
  const [configs, setConfigs] = useState<ConfigFile[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [configData, setConfigData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<ConfigFile[]>('/api/configs').then(res => {
      if (res.ok) setConfigs(res.data);
    });
  }, []);

  const handleSelectConfig = async (name: string) => {
    setSelectedConfig(name);
    setLoading(true);
    const res = await apiGet<unknown>(`/api/configs/${name}`);
    if (res.ok) {
      setConfigData(res.data);
    }
    setLoading(false);
  };

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">系统配置</h1>
        <p className="text-xs text-text-muted mt-0.5">只读视图 · Configs/ 目录 · 写操作留待后续</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {/* 左侧：配置文件列表 */}
        <div className="card">
          <div className="flex items-center gap-2 mb-3">
            <Settings size={14} className="text-brand-400" />
            <span className="text-xs font-semibold text-text-primary">配置文件</span>
          </div>

          {configs.length === 0 ? (
            <div className="text-xs text-text-muted py-8 text-center">暂无配置文件</div>
          ) : (
            <div className="space-y-1">
              {configs.map(cfg => (
                <div
                  key={cfg.name}
                  onClick={() => handleSelectConfig(cfg.name)}
                  className={`flex items-center gap-2 p-2.5 rounded-lg cursor-pointer transition-colors ${
                    selectedConfig === cfg.name
                      ? 'bg-brand-600/10 border border-brand-600/30'
                      : 'bg-surface-700/50 hover:bg-surface-700'
                  }`}
                >
                  <FileJson size={14} className="text-brand-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-text-primary truncate">{cfg.name}</div>
                    <div className="text-[10px] text-text-muted font-mono">{cfg.size} bytes</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右侧：配置内容 */}
        <div className="col-span-3 card">
          {!selectedConfig ? (
            <div className="text-center py-16 text-text-muted text-sm">
              ← 选择配置文件查看详情
            </div>
          ) : loading ? (
            <div className="text-center py-16 text-text-muted text-sm">加载中…</div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-text-primary font-mono">{selectedConfig}</h3>
                <span className="badge text-[9px]">只读</span>
              </div>
              <pre className="p-4 rounded-lg bg-surface-800 text-[11px] text-text-secondary font-mono overflow-auto max-h-[60vh] whitespace-pre-wrap">
                {JSON.stringify(configData, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
