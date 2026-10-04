/**
 * PreviewCache —— DOM 缓存包装器。
 * 设计规格：§5.2
 *
 * 已访问标签保持挂载，隐藏 via display:none。
 * 保持滚动位置、React 状态、输入状态。
 */
export default function PreviewCache({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex-1 flex flex-col min-h-0"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {children}
    </div>
  );
}
