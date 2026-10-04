import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import AppLayout from '@/components/Layout/AppLayout';
import AppTitleBar from '@/components/Layout/AppTitleBar';
import LoginPage from '@/views/Auth/LoginPage';
import { useAccountStore } from '@/stores/accountStore';

export default function App() {
  const init = useAccountStore((s) => s.init);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    init().then(() => setReady(true));
  }, [init]);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-950">
        <div className="text-surface-400">正在初始化...</div>
      </div>
    );
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
