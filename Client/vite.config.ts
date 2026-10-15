import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  base: "./", // 相对路径，支持 file:// 协议和 Electron 加载
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: "../dist/renderer", // 输出到项目根目录的 dist/renderer/
    emptyOutDir: true,
    // REV-291：生产包不得带 .map——`sourcesContent` 里是原始 TS 全文，
    // 而浏览器/局域网形态由 httpServer 直接托管 dist/renderer（已在服务端拒发 .map，
    // 但"删掉泄漏面"和"拒绝读取"是两件事：门禁只防运行时，构建产物才防外带）。
    sourcemap: mode !== "production",
    // AI 组件族分包——每个族生成独立 chunk，支持懒加载
    rollupOptions: {
      output: {
        manualChunks: {
          "ai-core-family": [
            "./src/ai-components/core/StreamBuffer",
            "./src/ai-components/core/CoTFolder",
            "./src/ai-components/core/MessageShell",
          ],
          "ai-harness-family": ["./src/ai-components/harness/ToolGroup"],
          "ai-registry": [
            "./src/ai-components/registry",
            "./src/ai-components/AIEventBus",
            "./src/ai-components/Subscribe",
            "./src/ai-components/FamilyErrorBoundary",
            "./src/ai-components/FallbackUI",
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `/api` 与令牌领取通道都要代理：后端现在默认只绑 127.0.0.1，
      // 因此 target 也写死 IPv4 回环（`localhost` 在 Windows 上可能解析成 ::1 → 连不上）。
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/internal/api-token": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
}));
