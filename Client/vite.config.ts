import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  base: './', // 相对路径，支持 file:// 协议和 Electron 加载
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: '../dist/renderer', // 输出到项目根目录的 dist/renderer/
    emptyOutDir: true,
    sourcemap: true,
    // AI 组件族分包——每个族生成独立 chunk，支持懒加载
    rollupOptions: {
      output: {
        manualChunks: {
          'ai-core-family': [
            './src/ai-components/core/StreamBuffer',
            './src/ai-components/core/CoTFolder',
            './src/ai-components/core/MessageShell',
          ],
          'ai-harness-family': [
            './src/ai-components/harness/ToolGroup',
          ],
          'ai-registry': [
            './src/ai-components/registry',
            './src/ai-components/AIEventBus',
            './src/ai-components/Subscribe',
            './src/ai-components/FamilyErrorBoundary',
            './src/ai-components/FallbackUI',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
