import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import AppLayout from '@/components/Layout/AppLayout';
import AppTitleBar from '@/components/Layout/AppTitleBar';
import ErrorBoundary from '@/components/ErrorBoundary';
import LoginPage from '@/views/Auth/LoginPage';
import OnboardingWizard from '@/views/Onboarding/OnboardingWizard';
import { useAccountStore } from '@/stores/accountStore';
import { useOnboardingStore } from '@/stores/onboardingStore';

/**
 * 应用根：初始化 → 首次运行引导 → 主界面。
 *
 * 整体包在 `ErrorBoundary` 里：任何视图渲染异常都会显示可读的错误与诊断信息，
 * 而不是留一个全黑窗口（2026-10-07 修复"跳过引导后全黑、无任何提示"）。
 */
export default function App() {
  return (
    <ErrorBoundary>
      <AppRoutes />
    </ErrorBoundary>
  );
}

function AppRoutes() {
  const init = useAccountStore((s) => s.init);
  const [ready, setReady] = useState(false);

  // 首次运行引导（未完成 → 全屏向导；非 Electron 环境自动跳过）
  const onboardingChecked = useOnboardingStore((s) => s.checked);
  const onboardingNeeded = useOnboardingStore((s) => s.needed);
  const checkOnboarding = useOnboardingStore((s) => s.check);

  useEffect(() => {
    // init() 内部已吞掉服务端不可用的错误；这里再兜一层，避免它抛出去导致永远停在"正在初始化"
    init()
      .catch((e: unknown) => {
        console.error('[App] 账号初始化失败（继续进入主界面）', e);
      })
      .finally(() => {
        setReady(true);
        void checkOnboarding();
      });
  }, [init, checkOnboarding]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-950">
        <div className="text-surface-400">正在初始化...</div>
      </div>
    );
  }

  /*
   * 首次运行引导（2026-10-06）：安装用户首次打开时先走初始化向导
   * （个性化 → 供应商 → API_KEY 与连通性校验 → 默认模型 → 使用引导）。
   *
   * 两个刻意的设计：
   * - 只有"主进程确认需要引导"才拦截（`checked && needed`）；IPC 不可用（浏览器/测试）
   *   或探测失败一律放行，避免把应用锁在向导里；
   * - 向导内可随时"跳过"，跳过后主界面照常进入（未配置模型时会提示无法对话）。
   */
  if (onboardingChecked && onboardingNeeded) {
    return <OnboardingWizard onFinish={() => {
      // 完成/跳过后立即重查一次状态，让主界面拿到最新的供应商与模型
      void checkOnboarding();
    }} />;
  }

  /*
   * 登录**可选**（产品决策，2026-10-02 评审后恢复）：
   *  - 未登录也能完整使用本地能力（对话、工具、任务、记忆）；
   *  - 登录入口保留在 `/login`，同时「账号 → 个人信息」面板内亦可登录；
   *  - 需要跨设备/重装恢复的数据（偏好、长时记忆、统计）在登录后同步。
   *
   * 之前这里用 AuthGuard 把整个应用锁在登录之后，导致**服务端不可用时应用完全不可用**，
   * 与"登录可选"的既定决策冲突（见 FE-030）。
   */
  return (
    <>
      {/* 顶部标题栏（含 Windows 窗口三键所在那一栏的项目标识） */}
      <AppTitleBar />
      <Routes>
      <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </>
  );
}
