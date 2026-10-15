import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@Infra": path.resolve(__dirname, "Src/Infra"),
      "@Tools": path.resolve(__dirname, "Src/Tools"),
      "@Services": path.resolve(__dirname, "Src/Services"),
      "@Core": path.resolve(__dirname, "Src/Core"),
      "@Interface": path.resolve(__dirname, "Src/Interface"),
      "@": path.resolve(__dirname, "Client/src"),
      // 确保测试使用单一 React 实例（避免 Client/node_modules 和根 node_modules 冲突）
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      zustand: path.resolve(__dirname, "node_modules/zustand"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // 真实凭据注入（§5）：从 .env/.env.local 读入，已存在的环境变量优先，缺失不失败。
    // 没有这一步，L3 真实模型端到端在 CI 里永远不成立，而缺凭据用例又"静默通过"。
    setupFiles: ["Tests/setup/credentials.ts"],
    include: [
      "Tests/**/*.spec.ts",
      "Tests/**/*.test.ts",
      "Tests/**/*.spec.tsx",
      "Tests/**/*.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["Src/**/*.ts", "Client/src/ai-components/**/*.{ts,tsx}"],
      exclude: ["Src/main.ts", "Src/**/types.ts", "**/*.d.ts"],
    },
    testTimeout: 30_000,
  },
});
