import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@Infra': path.resolve(__dirname, 'Src/Infra'),
      '@Tools': path.resolve(__dirname, 'Src/Tools'),
      '@Services': path.resolve(__dirname, 'Src/Services'),
      '@Core': path.resolve(__dirname, 'Src/Core'),
      '@Interface': path.resolve(__dirname, 'Src/Interface'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['Tests/**/*.spec.ts', 'Tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['Src/**/*.ts'],
      exclude: ['Src/main.ts', 'Src/**/types.ts'],
    },
    testTimeout: 30_000,
  },
});
