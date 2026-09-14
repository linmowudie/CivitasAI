/**
 * 离线横幅——后端不可达时显示。
 */
import { useSystemStore } from '@/stores/systemStore';
import { WifiOff } from 'lucide-react';

export default function OfflineBanner() {
  const online = useSystemStore(s => s.online);

  if (online) return null;

  return (
    <div className="bg-warning/15 border-b border-warning/30 px-4 py-1.5 flex items-center justify-center gap-2 text-xs text-warning font-mono">
      <WifiOff size={14} />
      <span>后端连接已断开，正在尝试重连…</span>
    </div>
  );
}
