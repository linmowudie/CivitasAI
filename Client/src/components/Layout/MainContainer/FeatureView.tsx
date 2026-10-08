/**
 * FeatureView —— 功能视图（9 种子视图）。
 * 设计规格：§4.2.3
 *
 * Phase 6 更新：memory/skills/custom-tools 接入真实 API 数据。
 */
import { useUIStore } from '@/stores/uiStore';
import { apiGet, type ApiResult } from '@/services/api';
import { ipcGetMemoryEntries, ipcGetSkills, ipcGetCustomTools } from '@/services/ipcApi';
import ApprovalQueue from '@/views/ApprovalQueue';
import AccountPanel from '@/views/AccountPanel';
import SystemConfig from '@/views/SystemConfig';
import { useEffect, useState } from 'react';

/* 各功能视图的数据配置 */
interface FeatureConfig {
  title: string;
  desc: string;
  items: string[];
}

/* 静态/半静态数据（后续接入真实 store/API） */
const featureData: Record<string, FeatureConfig> = {
  'loop-tasks': {
    title: 'Loop 任务管理',
    desc: '循环执行任务的状态与进度',
    items: [],
  },
  'harness': {
    title: 'Harness 工程检查',
    desc: '质量门禁与验证状态',
    items: ['G0 基础检查 — 通过', 'G1 安全门禁 — 通过', 'G2 质量验证 — 待执行'],
  },
  'memory': {
    title: '共享记忆',
    desc: 'Agent 间共享的上下文与知识',
    items: [],
  },
  'data-hub': {
    title: '数据中台',
    desc: '数据资源管理与服务',
    items: ['数据源连接管理', '数据管道监控', '数据质量报告'],
  },
  'skills': {
    title: 'Skill 技能',
    desc: '已安装的 Agent 技能',
    items: [],
  },
  'mcp': {
    title: 'MCP 服务',
    desc: 'Model Context Protocol 连接',
    items: ['browser-use — 浏览器自动化', 'chrome-devtools — 开发者工具', 'schedule — 定时任务'],
  },
  'custom-tools': {
    title: '自定义工具',
    desc: '用户自定义的外部工具',
    items: [],
  },
  'profile': {
    title: '个人信息',
    desc: '账号基本资料',
    items: ['角色: 管理员'],
  },
  'settings': {
    title: '系统设置',
    desc: '偏好与配置管理',
    items: [],
  },
};

/* API 数据类型 */
interface MemoryEntry {
  key: string;
  value: unknown;
  version: number;
  namespace: string;
  updatedAt: number;
}

interface SkillEntry {
  id: string;
  category: string;
  name: string;
  path: string;
  size: number;
  summary: string;
}

interface ToolEntry {
  name: string;
  description: string;
  dangerLevel: string;
  idempotent: boolean;
  reversible: boolean;
  isBuiltin: boolean;
}

/* 通用异步数据加载 Hook */
function useApiData<T>(endpoint: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<{ items: T; total: number }>(endpoint).then((result: ApiResult<{ items: T; total: number }>) => {
      if (cancelled) return;
      if (result.ok) {
        setData(result.data.items as unknown as T);
      } else {
        setError(result.error.message);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [endpoint]);

  return { data, loading, error };
}

export default function FeatureView() {
  const mainView = useUIStore((s) => s.mainView);

if (mainView.type !== 'feature') return null;

  const id = mainView.id;
  const data = featureData[id];

  /* approvals 视图：人工审批队列（工具安全门产生的审批请求，可批准/拒绝） */
  if (id === 'approvals') return <ApprovalQueue embedded />;

  /* profile 视图：账号与同步（服务端接入；原先为静态占位） */
  if (id === 'profile') return <AccountPanel />;

  /* settings 视图：接到真正可编辑的设置面板（2026-10-07 修复）
   *
   * 历史实现这里是"把 configStore.loaded 直接列成只读键值对"的占位视图；
   * `views/SystemConfig.tsx` 早在注释里写明"替换原 JSON 片段只读视图"，但这处接线一直没换，
   * 于是用户从「功能 → 设置」进来只能看到只读列表：**改不了配置、也找不到模型供应商入口**
   * （模型管理面板 `ModelProviderPanel` 挂在 SystemConfig 内部）。
   */
  if (id === 'settings') return <SystemConfig />;

  /* memory 视图：接入真实 API */
  if (id === 'memory') return <MemoryFeatureView />;
  /* skills 视图：接入真实 API */
  if (id === 'skills') return <SkillsFeatureView />;
  /* custom-tools 视图：接入真实 API */
  if (id === 'custom-tools') return <ToolsFeatureView />;

  if (!data) {
    return <div className="p-4 text-xs text-text-muted">视图开发中...</div>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* 标题卡 */}
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="text-sm font-semibold text-text-primary mb-1">{data.title}</div>
        <div className="text-[11px] text-text-secondary">{data.desc}</div>
      </div>

      {/* 列表项 */}
      {data.items.length > 0 ? (
        data.items.map((item, i) => (
          <div key={i} className="p-3 rounded-lg border border-surface-700 bg-surface-800 text-xs text-text-primary">
            {item}
          </div>
        ))
      ) : (
        <div className="p-4 text-center text-[11px] text-text-muted border border-dashed border-surface-700 rounded-lg">
          暂无数据
        </div>
      )}
    </div>
  );
}

/* ── Memory 子视图 ─────────────────────────────────────────────── */

function MemoryFeatureView() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // 优先 IPC 直连
        const ipcRes = await ipcGetMemoryEntries();
        if (ipcRes.ok && ipcRes.data) {
          if (!cancelled) setEntries(ipcRes.data.items as unknown as MemoryEntry[]);
        } else {
          // 降级 HTTP
          const res = await apiGet<{ items: MemoryEntry[]; total: number }>('/api/memory/entries');
          if (!cancelled) {
            if (res.ok) setEntries(res.data.items);
            else setError(res.error.message);
          }
        }
      } catch {
        const res = await apiGet<{ items: MemoryEntry[]; total: number }>('/api/memory/entries');
        if (!cancelled) {
          if (res.ok) setEntries(res.data.items);
          else setError(res.error.message);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="text-sm font-semibold text-text-primary mb-1">共享记忆</div>
        <div className="text-[11px] text-text-secondary">Agent 间共享的上下文与知识</div>
      </div>

      {loading && <div className="p-4 text-center text-[11px] text-text-muted">加载中...</div>}
      {error && <div className="p-3 text-[11px] text-red-400 bg-red-900/20 rounded-lg">加载失败: {error}</div>}

      {entries && Array.isArray(entries) && entries.length > 0 ? (
        entries.map((entry) => (
          <div key={entry.key} className="p-3 rounded-lg border border-surface-700 bg-surface-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-brand-400">{entry.key}</span>
              <span className="text-[10px] text-text-muted">v{entry.version}</span>
            </div>
            <div className="text-[11px] text-text-secondary truncate">
              {typeof entry.value === 'object' ? JSON.stringify(entry.value).slice(0, 100) : String(entry.value).slice(0, 100)}
            </div>
          </div>
        ))
      ) : !loading && !error && (
        <div className="p-4 text-center text-[11px] text-text-muted border border-dashed border-surface-700 rounded-lg">
          暂无记忆条目
        </div>
      )}
    </div>
  );
}

/* ── Skills 子视图 ─────────────────────────────────────────────── */

function SkillsFeatureView() {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // 优先 IPC 直连
        const ipcRes = await ipcGetSkills();
        if (ipcRes.ok && ipcRes.data) {
          if (!cancelled) setSkills(ipcRes.data.items as unknown as SkillEntry[]);
        } else {
          // 降级 HTTP
          const res = await apiGet<{ items: SkillEntry[]; total: number }>('/api/skills');
          if (!cancelled) {
            if (res.ok) setSkills(res.data.items);
            else setError(res.error.message);
          }
        }
      } catch {
        const res = await apiGet<{ items: SkillEntry[]; total: number }>('/api/skills');
        if (!cancelled) {
          if (res.ok) setSkills(res.data.items);
          else setError(res.error.message);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="text-sm font-semibold text-text-primary mb-1">Skill 技能</div>
        <div className="text-[11px] text-text-secondary">已安装的 Agent 技能</div>
      </div>

      {loading && <div className="p-4 text-center text-[11px] text-text-muted">加载中...</div>}
      {error && <div className="p-3 text-[11px] text-red-400 bg-red-900/20 rounded-lg">加载失败: {error}</div>}

      {skills && Array.isArray(skills) && skills.length > 0 ? (
        skills.map((skill) => (
          <div key={skill.id} className="p-3 rounded-lg border border-surface-700 bg-surface-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-text-primary">{skill.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-700 text-text-muted">{skill.category}</span>
            </div>
            <div className="text-[11px] text-text-secondary">{skill.summary}</div>
          </div>
        ))
      ) : !loading && !error && (
        <div className="p-4 text-center text-[11px] text-text-muted border border-dashed border-surface-700 rounded-lg">
          暂无技能
        </div>
      )}
    </div>
  );
}

/* ── Custom Tools 子视图 ───────────────────────────────────────── */

function ToolsFeatureView() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // 优先 IPC 直连
        const ipcRes = await ipcGetCustomTools();
        if (ipcRes.ok && ipcRes.data) {
          if (!cancelled) setTools(ipcRes.data.items as unknown as ToolEntry[]);
        } else {
          // 降级 HTTP
          const res = await apiGet<{ items: ToolEntry[]; total: number }>('/api/tools/custom');
          if (!cancelled) {
            if (res.ok) setTools(res.data.items);
            else setError(res.error.message);
          }
        }
      } catch {
        const res = await apiGet<{ items: ToolEntry[]; total: number }>('/api/tools/custom');
        if (!cancelled) {
          if (res.ok) setTools(res.data.items);
          else setError(res.error.message);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="p-4 rounded-lg border border-surface-700 bg-surface-800">
        <div className="text-sm font-semibold text-text-primary mb-1">自定义工具</div>
        <div className="text-[11px] text-text-secondary">用户自定义的外部工具</div>
      </div>

      {loading && <div className="p-4 text-center text-[11px] text-text-muted">加载中...</div>}
      {error && <div className="p-3 text-[11px] text-red-400 bg-red-900/20 rounded-lg">加载失败: {error}</div>}

      {tools && Array.isArray(tools) && tools.length > 0 ? (
        tools.map((tool) => (
          <div key={tool.name} className="p-3 rounded-lg border border-surface-700 bg-surface-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-mono text-text-primary">{tool.name}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                tool.dangerLevel === 'critical' ? 'bg-red-900/40 text-red-400' :
                tool.dangerLevel === 'high' ? 'bg-orange-900/40 text-orange-400' :
                tool.dangerLevel === 'medium' ? 'bg-yellow-900/40 text-yellow-400' :
                'bg-surface-700 text-text-muted'
              }`}>{tool.dangerLevel}</span>
            </div>
            <div className="text-[11px] text-text-secondary">{tool.description || '无描述'}</div>
          </div>
        ))
      ) : !loading && !error && (
        <div className="p-4 text-center text-[11px] text-text-muted border border-dashed border-surface-700 rounded-lg">
          暂无自定义工具，可通过插件系统添加
        </div>
      )}
    </div>
  );
}
