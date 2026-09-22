/**
 * DIRECT 模式可视化——环形计时 + 流式气泡。
 *
 * 设计参考：
 *   - Claude / ChatGPT 单轮响应气泡（含 "思考中" 折叠）
 *   - Android 16 Progress-Centric Notification（Segments + Points 分段+关键节点）
 *   - 首字节延迟 TTFB 环形计时器（业界 AI 对话通用样式）
 *
 * 回答的问题：Director 从接到任务到给出结果，一共用了多久？首字什么时候出现？Token 花了多少？
 */
import { useEffect, useState } from 'react';
import ModeShell from './ModeShell';
import { DEMO_DIRECT, fmtMs, type DirectDemo } from './demoData';

interface ElapsedRingProps {
  ttfb: number;
  total: number;
  running: boolean;
}

function ElapsedRing({ ttfb, total, running }: ElapsedRingProps) {
  const [now, setNow] = useState(running ? 0 : total);
  useEffect(() => {
    if (!running) return;
    const t0 = performance.now();
    const id = setInterval(() => setNow(performance.now() - t0), 50);
    return () => clearInterval(id);
  }, [running]);

  const size = 148;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const progress = Math.min(now / Math.max(total, 1), 1);
  const ttfbAngle = (ttfb / Math.max(total, 1)) * 2 * Math.PI - Math.PI / 2;
  const ttfbX = size / 2 + r * Math.cos(ttfbAngle);
  const ttfbY = size / 2 + r * Math.sin(ttfbAngle);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" strokeOpacity={0.08}
          strokeWidth={stroke} fill="none" className="text-brand-400" />
        <circle cx={size / 2} cy={size / 2} r={r}
          stroke="url(#elapsedGrad)" strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - progress)}
          style={{ transition: running ? 'none' : 'stroke-dashoffset 300ms ease' }} />
        <defs>
          <linearGradient id="elapsedGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#0891b2" />
          </linearGradient>
        </defs>
      </svg>
      {/* TTFB 标记 */}
      <div className="absolute" style={{
        left: ttfbX - 4, top: ttfbY - 4, width: 8, height: 8,
        borderRadius: '50%', background: '#f59e0b',
        boxShadow: '0 0 6px rgba(245,158,11,0.8)',
      }} title={`TTFB ${fmtMs(ttfb)}`} />
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="stat-value text-text-primary" style={{ fontSize: 24 }}>{fmtMs(now)}</div>
        <div className="text-[10px] text-text-muted mt-1 font-mono">总耗时</div>
      </div>
    </div>
  );
}

export default function DirectExecutionViz({ data = DEMO_DIRECT }: { data?: DirectDemo }) {
  const running = data.status === 'running';
  const streamEvents = data.streamTimeline;
  const maxTs = Math.max(...streamEvents.map(e => e.ts), data.totalDuration);

  return (
    <ModeShell
      mode="DIRECT"
      title="简单任务 · Director 单流响应"
      question="Director 从接到任务到给出结果用了多久？首字什么时候出现？Token 消耗多少？"
      reference="Claude 响应气泡 + Android Progress Segments + TTFB 环形计时"
    >
      <div className="grid grid-cols-[160px_1fr] gap-6 items-start">
        {/* ── 左：环形计时 ───────────────────── */}
        <div className="flex flex-col items-center gap-3">
          <ElapsedRing ttfb={data.ttfb} total={data.totalDuration} running={running} />
          <div className="text-center">
            <div className="text-[10px] text-text-muted font-mono">TTFB</div>
            <div className="text-sm font-mono text-warning">{fmtMs(data.ttfb)}</div>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-text-muted font-mono">Tokens</div>
            <div className="text-sm font-mono text-brand-400">{data.tokensConsumed}</div>
            <div className="text-[10px] text-text-muted mt-0.5 font-mono">余额 {data.balanceAfter}</div>
          </div>
        </div>

        {/* ── 右：流式时间线 + 响应气泡 ─────── */}
        <div className="min-w-0 space-y-3">
          {/* 关键节点时间线（横向 Segment Bar） */}
          <div>
            <div className="text-[10px] text-text-muted mb-1.5 font-mono">流式关键节点</div>
            <div className="relative h-9 rounded bg-surface-900 border border-surface-700 overflow-hidden">
              {streamEvents.map((e, i) => {
                const left = (e.ts / maxTs) * 100;
                return (
                  <div key={i} className="absolute top-0 bottom-0 flex flex-col items-center"
                    style={{ left: `${left}%`, transform: 'translateX(-50%)' }}>
                    <div className="w-0.5 h-3.5 bg-brand-500 mt-1" />
                    <div className="text-[9px] text-text-secondary font-mono whitespace-nowrap mt-0.5">
                      {fmtMs(e.ts)}
                    </div>
                  </div>
                );
              })}
              {/* 数据流光带 */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 data-flow-line h-[2px]" />
            </div>
            <div className="mt-2 grid gap-1">
              {streamEvents.map((e, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-text-muted w-14">{fmtMs(e.ts)}</span>
                  <span className="text-text-secondary">{e.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 响应气泡 */}
          <div className="chat-bubble agent flex gap-2.5">
            <div className="chat-avatar agent flex-shrink-0">D</div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-text-muted font-mono mb-1">
                Director · huawei/glm-5.1 · {fmtMs(data.totalDuration)}
              </div>
              <div className="chat-content text-text-primary">
                {data.outputPreview}
                {running && <span className="streaming-cursor" />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModeShell>
  );
}
