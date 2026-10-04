/**
 * FeatureList —— 左侧面板底部向上可扩展功能列表。
 * 设计规格：§3.2
 *
 * 审批入口带待处理角标：审批是唯一需要人工介入的功能项，
 * 数据由 useApprovalPolling 共享轮询（Electron 下另有事件即时刷新）。
 *
 * 账号入口带登录态指示点：已登录（绿）/ 未登录（灰），登录后鼠标悬停显示邮箱；
 * 数据来自 accountStore（服务端登录态），不参与轮询。
 */
import { useEffect } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useApprovalStore } from '@/stores/approvalStore';
import { useApprovalPolling } from '@/hooks/useApprovalPolling';
import { useAccountStore } from '@/stores/accountStore';

interface FeatureChild {
  id: string;
  label: string;
}

interface FeatureItem {
  id: string;
  label: string;
  icon: string;
  children: FeatureChild[];
}

const featureItems: FeatureItem[] = [
  { id: 'approvals', label: '审批', icon: '⚖', children: [] },
  { id: 'loop-tasks', label: 'Loop 任务', icon: '⟳', children: [] },
  { id: 'harness', label: 'Harness 工程检查', icon: '⚙', children: [] },
  { id: 'memory', label: '记忆', icon: '◈', children: [] },
  { id: 'data-hub', label: '数据中台', icon: '◫', children: [] },
  {
    id: 'plugins',
    label: '插件',
    icon: '⧩',
    children: [
      { id: 'skills', label: 'Skill' },
      { id: 'mcp', label: 'MCP' },
      { id: 'custom-tools', label: '自定义工具' },
    ],
  },
  {
    id: 'account',
    label: '账号',
    icon: '◉',
    children: [
      { id: 'profile', label: '个人信息' },
      { id: 'settings', label: '设置' },
    ],
  },
];

export default function FeatureList() {
  const { mainView, setMainView, expandedFeatures, toggleFeature } = useUIStore();
  const pendingCount = useApprovalStore(
    (s) => s.approvals.filter((a) => a.status === 'PENDING').length,
  );
  const accountReady = useAccountStore((s) => s.ready);
  const accountUser = useAccountStore((s) => s.user);
  const initAccount = useAccountStore((s) => s.init);

  useApprovalPolling();

  // 启动时恢复登录态（store 内部幂等；不阻塞其他功能）
  useEffect(() => { void initAccount(); }, [initAccount]);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-4 py-1.5">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">功能</span>
      </div>

      {featureItems.map((feat) => {
        const hasChildren = feat.children.length > 0;
        const isExpanded = expandedFeatures.has(feat.id);
        const isActive = mainView.type === 'feature' && mainView.id === feat.id;

        return (
          <div key={feat.id}>
            {/* 主项 */}
            <button
              className={`
                w-full flex items-center gap-2 px-4 py-1.5 text-xs transition-colors
                ${isActive ? 'bg-brand-500/10 text-brand-400' : 'text-text-secondary hover:bg-surface-700/50 hover:text-text-primary'}
              `}
              onClick={() => {
                if (hasChildren) {
                  toggleFeature(feat.id);
                } else {
                  setMainView({ type: 'feature', id: feat.id });
                }
              }}
            >
              <span className="text-[11px] w-4 text-center flex-shrink-0">{feat.icon}</span>
              <span className="flex-1 text-left truncate">{feat.label}</span>
              {/* 待处理审批角标 */}
              {feat.id === 'approvals' && pendingCount > 0 && (
                <span
                  className="flex-shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-danger text-white
                             text-[10px] font-bold flex items-center justify-center"
                  title={`${pendingCount} 项待审批`}
                >
                  {pendingCount}
                </span>
              )}
              {hasChildren && (
                isExpanded
                  ? <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
                  : <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
              )}
              {/* 账号登录态指示点（绿=已登录，灰=未登录） */}
              {feat.id === 'account' && accountReady && (
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${accountUser ? 'bg-success' : 'bg-surface-400'}`}
                  title={accountUser ? `已登录：${accountUser.email}` : '未登录（进入「个人信息」可登录账号）'}
                />
              )}
            </button>

            {/* 子项（展开时显示） */}
            {hasChildren && isExpanded && (
              <div className="ml-6 flex flex-col gap-0.5 py-0.5">
                {feat.children.map((child) => {
                  const isChildActive = mainView.type === 'feature' && mainView.id === child.id;
                  return (
                    <button
                      key={child.id}
                      className={`
                        w-full flex items-center gap-2 px-3 py-1 text-[11px] rounded-sm transition-colors
                        ${isChildActive ? 'bg-brand-500/10 text-brand-400' : 'text-text-muted hover:bg-surface-700/50 hover:text-text-secondary'}
                      `}
                      onClick={() => setMainView({ type: 'feature', id: child.id })}
                    >
                      <span className="truncate">{child.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
