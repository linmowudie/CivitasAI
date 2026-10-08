/**
 * @module Services/Onboarding/onboardingState
 * @description
 * 首次运行引导（onboarding）状态机与持久化。
 *
 * 语义：
 * - 落盘位置：`<DATA_ROOT>/.state/onboarding.json`（安装态 = `%APPDATA%\CivitasAI\.state\`）
 * - **文件不存在 = 未初始化** → 渲染进程进入全屏引导向导（见 `Client/src/views/Onboarding`）
 * - `completed: true` 后不再拦截；`skipped: true` 表示用户主动跳过（仍可稍后从设置重跑）
 * - 幂等：重复完成只更新时间戳与引导版本，不丢历史字段
 *
 * 设计取舍：
 * - 状态文件与"用户配置"分离：配置（端口/路由/日志级别）写 `Configs/local.json`（最高覆盖层），
 *   这里只记"引导是否完成 + 选了什么"，便于重跑引导与排障。
 * - 原子写（`atomicWrite`）：避免半写文件导致"引导永远弹"或"直接跳过"。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Result } from '../../Infra/types.js';
import { ok, err } from '../../Infra/types.js';
import { atomicWrite } from '../../Infra/Fs/atomicWrite.js';
import { ensureDirSafe, getStateDir } from '../../Infra/Fs/pathResolver.js';

// ── 类型 ────────────────────────────────────────────────────────────

/** 引导中收集的个性化项（写用户配置层时的白名单来源） */
export interface OnboardingPersonalization {
  /** 工作空间根（用户可选；留空表示使用默认） */
  workspaceRoot?: string;
  /** 日志级别 */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** 主题（当前仅深色，字段预留） */
  theme?: 'dark' | 'light';
  /** 界面语言（当前仅中文，字段预留） */
  language?: string;
}

/** 引导记录 */
export interface OnboardingState {
  /** 是否已完成引导（false/缺失 = 未初始化） */
  completed: boolean;
  /** 用户主动跳过（不等于完成，仍会提示未配置模型） */
  skipped?: boolean;
  /** 完成/跳过时间（ms） */
  completedAt?: number;
  /** 引导版本（后续步骤变更时可据此重新引导） */
  version?: string;
  /** 个性化选择（仅记录，实际生效写入 Configs/local.json） */
  personalization?: OnboardingPersonalization;
  /** 选定的主供应商摘要（不含 API_KEY） */
  provider?: {
    name: string;
    displayName: string;
    baseUrl: string;
    defaultModel?: string;
  };
}

/** 当前引导版本：步骤集变更时递增（旧记录会被视为"需要重新引导"） */
export const ONBOARDING_VERSION = '1';

// ── 路径 ────────────────────────────────────────────────────────────

export function getOnboardingStatePath(): string {
  return join(getStateDir(), 'onboarding.json');
}

// ── 读写 ────────────────────────────────────────────────────────────

/** 读取引导状态（文件缺失/损坏 → 视为未初始化） */
export function readOnboardingState(): OnboardingState {
  const file = getOnboardingStatePath();
  if (!existsSync(file)) return { completed: false };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<OnboardingState>;
    return {
      completed: parsed.completed === true,
      skipped: parsed.skipped === true,
      completedAt: typeof parsed.completedAt === 'number' ? parsed.completedAt : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      personalization: parsed.personalization,
      provider: parsed.provider,
    };
  } catch {
    // 损坏：当作未初始化，让人重新走一遍（比"静默跳过"安全）
    return { completed: false };
  }
}

/** 写入引导状态（与既有字段合并，幂等） */
export function writeOnboardingState(patch: Partial<OnboardingState>): Result<OnboardingState> {
  const dir = getStateDir();
  const dirResult = ensureDirSafe(dir);
  if (!dirResult.ok) {
    return err(`引导状态目录不可写：${dir}（${dirResult.error ?? '未知原因'}）`, 'ERROR');
  }

  const current = readOnboardingState();
  const next: OnboardingState = {
    ...current,
    ...patch,
    personalization: { ...(current.personalization ?? {}), ...(patch.personalization ?? {}) },
    provider: patch.provider ?? current.provider,
  };

  const writeResult = atomicWrite(getOnboardingStatePath(), JSON.stringify(next, null, 2));
  if (!writeResult.ok) {
    return err(`引导状态写入失败：${writeResult.error}`, 'ERROR');
  }
  return ok(next);
}

/** 标记引导完成 */
export function completeOnboarding(payload: Omit<OnboardingState, 'completed' | 'completedAt' | 'version'> = {}): Result<OnboardingState> {
  return writeOnboardingState({
    ...payload,
    completed: true,
    skipped: false,
    completedAt: Date.now(),
    version: ONBOARDING_VERSION,
  });
}

/** 标记用户跳过引导（后续仍可重跑） */
export function skipOnboarding(): Result<OnboardingState> {
  return writeOnboardingState({
    completed: false,
    skipped: true,
    completedAt: Date.now(),
    version: ONBOARDING_VERSION,
  });
}

/** 重置引导状态（设置里"重新运行初始化引导"用） */
export function resetOnboarding(): Result<boolean> {
  const file = getOnboardingStatePath();
  if (!existsSync(file)) return ok(false);
  try {
    // 直接覆盖为空状态，保留文件以区分"从没跑过"和"跑过又被重置"（二者都视为未初始化）
    const result = atomicWrite(file, JSON.stringify({ completed: false }, null, 2));
    if (!result.ok) return err(`重置引导状态失败：${result.error}`, 'ERROR');
    return ok(true);
  } catch (e) {
    return err(`重置引导状态失败：${e instanceof Error ? e.message : String(e)}`, 'ERROR');
  }
}

/** 判断是否需要进入引导（未完成且未跳过，或引导版本过期） */
export function needsOnboarding(): boolean {
  const state = readOnboardingState();
  if (state.completed) {
    // 引导版本升级 → 视为需要重新引导（未来步骤扩展时生效）
    return state.version !== ONBOARDING_VERSION;
  }
  return !state.skipped;
}
