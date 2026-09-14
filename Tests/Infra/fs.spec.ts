/**
 * S1-⑤ Infra/Fs 模块测试
 *
 * 覆盖：fsSafe / atomicWrite / quotaManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

import { safeReadFile, safeWriteFile, safeReadJson, safeWriteJson, validateDirectory, ensureDir, safeExists, safeListDir } from '../../Src/Infra/Fs/fsSafe.js';
import { atomicWrite, atomicWriteBuffer, atomicAppend } from '../../Src/Infra/Fs/atomicWrite.js';
import { setQuota, canWrite, recordUsage, getUsage, scanDirectorySize, clearQuotas, syncUsage } from '../../Src/Infra/Fs/quotaManager.js';
import { initPathGuard, resetPathGuard } from '../../Src/Infra/Security/pathGuard.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TEST_DIR = join(ROOT, 'Data', '_test_fs');

function cleanup(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('S1-⑤ Fs 模块', () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    resetPathGuard();
    initPathGuard({ projectRoot: ROOT, forbiddenPaths: ['Data/Auth/'] });
  });

  afterEach(() => {
    cleanup();
    resetPathGuard();
    clearQuotas();
  });

  // ===== fsSafe =====
  describe('fsSafe', () => {
    it('safeWriteFile + safeReadFile 读写文件', () => {
      const filePath = join(TEST_DIR, 'test.txt');
      const writeResult = safeWriteFile(filePath, 'hello world');
      expect(writeResult.ok).toBe(true);

      const readResult = safeReadFile(filePath);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value).toBe('hello world');
      }
    });

    it('safeReadFile 不存在的文件返回错误', () => {
      const result = safeReadFile(join(TEST_DIR, 'nonexistent.txt'));
      expect(result.ok).toBe(false);
    });

    it('safeWriteFile 自动创建父目录', () => {
      const filePath = join(TEST_DIR, 'sub', 'deep', 'test.txt');
      const result = safeWriteFile(filePath, 'nested');
      expect(result.ok).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    });

    it('safeReadJson + safeWriteJson', () => {
      const filePath = join(TEST_DIR, 'test.json');
      const data = { name: 'test', value: 42 };
      expect(safeWriteJson(filePath, data).ok).toBe(true);

      const result = safeReadJson<typeof data>(filePath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('test');
        expect(result.value.value).toBe(42);
      }
    });

    it('validateDirectory 验证目录', () => {
      const result = validateDirectory(TEST_DIR);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exists).toBe(true);
        expect(result.value.writable).toBe(true);
      }
    });

    it('validateDirectory 不存在的目录（不创建）', () => {
      const result = validateDirectory(join(TEST_DIR, 'nonexistent'));
      expect(result.ok).toBe(false);
    });

    it('validateDirectory 不存在的目录（自动创建）', () => {
      const result = validateDirectory(join(TEST_DIR, 'new_dir'), { create: true });
      expect(result.ok).toBe(true);
      expect(existsSync(join(TEST_DIR, 'new_dir'))).toBe(true);
    });

    it('safeExists 检查文件存在', () => {
      const filePath = join(TEST_DIR, 'exists.txt');
      writeFileSync(filePath, 'test');
      expect(safeExists(filePath)).toBe(true);
      expect(safeExists(join(TEST_DIR, 'no.txt'))).toBe(false);
    });

    it('safeListDir 列出目录', () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), 'a');
      writeFileSync(join(TEST_DIR, 'b.txt'), 'b');
      const result = safeListDir(TEST_DIR);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain('a.txt');
        expect(result.value).toContain('b.txt');
      }
    });

    it('禁止路径被拒绝', () => {
      const result = safeWriteFile(join(ROOT, 'Data/Auth/secret'), 'hack');
      expect(result.ok).toBe(false);
    });
  });

  // ===== atomicWrite =====
  describe('atomicWrite', () => {
    it('原子写入成功', () => {
      const filePath = join(TEST_DIR, 'atomic.txt');
      const result = atomicWrite(filePath, 'atomic content');
      expect(result.ok).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe('atomic content');
    });

    it('原子写入覆盖已有文件', () => {
      const filePath = join(TEST_DIR, 'overwrite.txt');
      writeFileSync(filePath, 'original');
      atomicWrite(filePath, 'replaced');
      expect(readFileSync(filePath, 'utf-8')).toBe('replaced');
    });

    it('原子写入 Buffer', () => {
      const filePath = join(TEST_DIR, 'buffer.bin');
      const buf = Buffer.from('binary data');
      const result = atomicWriteBuffer(filePath, buf);
      expect(result.ok).toBe(true);
      expect(readFileSync(filePath)).toEqual(buf);
    });

    it('原子追加', () => {
      const filePath = join(TEST_DIR, 'append.txt');
      atomicWrite(filePath, 'line1\n');
      atomicAppend(filePath, 'line2\n');
      expect(readFileSync(filePath, 'utf-8')).toBe('line1\nline2\n');
    });

    it('无 fsync 模式', () => {
      const filePath = join(TEST_DIR, 'nofsync.txt');
      const result = atomicWrite(filePath, 'no fsync', { fsync: false });
      expect(result.ok).toBe(true);
    });
  });

  // ===== quotaManager =====
  describe('quotaManager', () => {
    it('setQuota + getUsage', () => {
      setQuota(TEST_DIR, { maxBytes: 1000, warnRatio: 0.8 });
      const usage = getUsage(TEST_DIR);
      expect(usage).not.toBeNull();
      expect(usage!.maxBytes).toBe(1000);
      expect(usage!.usedBytes).toBe(0);
      expect(usage!.exceeded).toBe(false);
    });

    it('canWrite 配额内允许', () => {
      setQuota(TEST_DIR, { maxBytes: 1000 });
      expect(canWrite(join(TEST_DIR, 'file.txt'), 500)).toBe(true);
    });

    it('canWrite 超额拒绝', () => {
      setQuota(TEST_DIR, { maxBytes: 100 });
      recordUsage(TEST_DIR, 90);
      expect(canWrite(join(TEST_DIR, 'file.txt'), 20)).toBe(false);
    });

    it('recordUsage 累计使用量', () => {
      setQuota(TEST_DIR, { maxBytes: 1000 });
      recordUsage(TEST_DIR, 100);
      recordUsage(TEST_DIR, 200);
      const usage = getUsage(TEST_DIR);
      expect(usage!.usedBytes).toBe(300);
      expect(usage!.usageRatio).toBeCloseTo(0.3);
    });

    it('warning 阈值', () => {
      setQuota(TEST_DIR, { maxBytes: 100, warnRatio: 0.8 });
      recordUsage(TEST_DIR, 85);
      const usage = getUsage(TEST_DIR);
      expect(usage!.warning).toBe(true);
    });

    it('exceeded 超限', () => {
      setQuota(TEST_DIR, { maxBytes: 100 });
      recordUsage(TEST_DIR, 150);
      const usage = getUsage(TEST_DIR);
      expect(usage!.exceeded).toBe(true);
    });

    it('scanDirectorySize 扫描目录', () => {
      writeFileSync(join(TEST_DIR, 'a.txt'), 'hello');
      writeFileSync(join(TEST_DIR, 'b.txt'), 'world!');
      const size = scanDirectorySize(TEST_DIR);
      expect(size).toBe(11); // 5 + 6
    });

    it('syncUsage 同步实际使用量', () => {
      setQuota(TEST_DIR, { maxBytes: 10000 });
      writeFileSync(join(TEST_DIR, 'data.txt'), 'some data here');
      const usage = syncUsage(TEST_DIR);
      expect(usage).not.toBeNull();
      expect(usage!.usedBytes).toBe(14); // 'some data here' = 14 bytes
    });

    it('无配额时 canWrite 始终允许', () => {
      expect(canWrite(join(TEST_DIR, 'any.txt'), 999999)).toBe(true);
    });
  });
});
