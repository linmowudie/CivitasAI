/**
 * 应用入口组合：路由 + 应用根。
 *
 * 为什么单独抽一层：
 * - `main.tsx` 需要 `<BrowserRouter>` 包裹，但测试文件位于 `Tests/` 下，**无法裸导入**
 *   `react-router-dom`（该依赖解析自 `Client/node_modules`，测试目录解析不到）；
 * - 抽成 `AppRoot` 后，测试渲染的就是**与生产完全一致的入口组合**（含路由），
 *   而不是各写一份包裹代码——路由兜底这类 bug 才可能被测到。
 */

import { BrowserRouter } from 'react-router-dom';

import App from './App';

export default function AppRoot() {
  return (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}
