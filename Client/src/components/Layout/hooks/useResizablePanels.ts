/**
 * useResizablePanels —— 三栏布局拖拽调整面板宽度 hook。
 *
 * 功能：
 *   - ResizeObserver 跟踪容器宽度，动态计算面板最大宽度
 *   - mousedown/mousemove/mouseup 拖拽调整
 *   - 面板状态读写 uiStore
 *
 * 设计规格：Docs/Client/02-前端改造基础/三栏自适应工作界面设计规格.md §7
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { useUIStore, PANEL_MIN } from '@/stores/uiStore';

const HANDLE_WIDTH = 6;
const LEFT_PANEL_RATIO = 0.25;
const RIGHT_PANEL_RATIO = 0.5;

export function useResizablePanels() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);

  const {
    leftPanelWidth, setLeftPanelWidth,
    rightPanelWidth, setRightPanelWidth,
  } = useUIStore();

  /* ── ResizeObserver: 跟踪容器宽度 ── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const leftPanelMax = Math.max(PANEL_MIN + 20, Math.floor(containerWidth * LEFT_PANEL_RATIO));
  const rightPanelMax = Math.max(PANEL_MIN + 20, Math.floor(containerWidth * RIGHT_PANEL_RATIO));

  /* ── 拖拽状态 ── */
  const dragRef = useRef<{
    side: 'left' | 'right';
    startX: number;
    startWidth: number;
  } | null>(null);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      if (d.side === 'left') {
        setLeftPanelWidth(Math.min(leftPanelMax, Math.max(PANEL_MIN, d.startWidth + delta)));
      } else {
        setRightPanelWidth(Math.min(rightPanelMax, Math.max(PANEL_MIN, d.startWidth - delta)));
      }
    },
    [leftPanelMax, rightPanelMax, setLeftPanelWidth, setRightPanelWidth],
  );

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const startDrag = useCallback((side: 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = {
      side,
      startX: e.clientX,
      startWidth: side === 'left' ? leftPanelWidth : rightPanelWidth,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftPanelWidth, rightPanelWidth]);

  return {
    containerRef,
    containerWidth,
    leftPanelWidth,
    rightPanelWidth,
    leftPanelMax,
    rightPanelMax,
    startDrag,
    HANDLE_WIDTH,
  };
}
