/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // 集成测试共用一个测试库（每个用例前清表），因此串行执行，避免相互干扰
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
