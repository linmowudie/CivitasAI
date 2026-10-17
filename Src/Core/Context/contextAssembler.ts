/**
 * @module Core/Context/contextAssembler
 * @description
 * 组装 `Observation`（**看得见什么**）并**保证前缀稳定**。
 *
 * 设计出处：Docs/Dev/L1编排设计/18-ContextAssembler.md ·
 *   13-ReAct跨切面约束.md §14（前缀稳定）/§15（会话·对话·内层循环三尺度）·
 *   03-组装检查树.md §6（前缀 4 条 + 会话 3 条判据）
 *
 * 四条硬规则（每条都有负向测试）：
 *   1. **恒定区必须字节恒定**（会话内）：漂移即拒绝 —— 否则工具区/静态段一变，**全部**前缀失效。
 *   2. **稳定键原位替换**；回合段按**变更频率升序**排列（原位替换只保护"该键之前"的前缀）。
 *   3. **对话/组件边界只写边界键，绝不清空 store**；**不得拼接上一对话的消息**。
 *   4. **可见面只能是自己声明的子范围**；子件不得等于宿主全集（嵌套退化的假隔离）。
 */

import { createHash } from "node:crypto";

import type { Result } from "../../Infra/types.js";
import { ok, err } from "../../Infra/types.js";

/** 上下文分区（与 `Src/Services/Context/contextStore.ts` 的 `ContextSection` 结构兼容） */
export interface ContextSectionPort {
  key: string;
  content: string;
  timestamp: number;
}

/** `ContextStore` 的结构子集（真实 store 直接满足，无需适配器） */
export interface ContextStorePort {
  put(section: ContextSectionPort): boolean;
  get(key: string): ContextSectionPort | undefined;
  toAppendMessages(): Array<{ role: "system"; content: string }>;
}

export interface ChatMessagePort {
  role: string;
  content: string;
}

/** 输入集：**看得见什么**（可见上下文的截取范围） */
export interface ContextSelector {
  sections: string[];
  history: { recentTurns: number } | "all";
  shared?: { domains: Array<"l1" | "coop" | "system"> };
}

/** 一组件的输出观察 */
export interface Observation {
  /** 按**变更频率升序**排列的回合段（稳定的在前） */
  contextSections: Array<{ key: string; content: string }>;
  history: ChatMessagePort[];
  upstream: Record<string, unknown>;
  events: unknown[];
  env?: unknown;
}

export type SectionScope = "session" | "dialogue" | "component";

/** 分区声明：变更频率用于排序（**越小越稳定、越靠前**） */
export interface SectionSpec {
  key: string;
  content: string;
  changeFreq: number;
  scope: SectionScope;
}

/** 共享上下文读取端口（pull 类数据；真实适配器在 S7 接 `globalWorkspace`） */
export type SharedReader = (
  domain: "l1" | "coop" | "system",
) => Promise<Result<ReadonlyArray<{ key: string; content: string }>>>;

export const BOUNDARY_KEY_DIALOGUE = "ctx:dialogue:boundary";
export const BOUNDARY_KEY_COMPONENT = "ctx:outer:component-boundary";
export const KEY_DIALOGUE_GOAL = "ctx:dialogue:goal";

export interface ContextAssemblerDeps {
  store: ContextStorePort;
  now?: () => number;
  /** 同一域两次主动拉取的最小间隔（毫秒）—— 防"每轮重拉" */
  pullMinIntervalMs?: number;
}

export interface ContextAssembler {
  /** 写入会话级恒定区并校验字节恒定（漂移 ⇒ 拒绝） */
  applyConstantZone(
    staticPrompt: string,
    toolNames: string[],
  ): Result<{ hash: string }>;
  /** 写入一个回合段（稳定键原位替换） */
  putSection(spec: SectionSpec): Result<void>;
  /** 新对话：写边界键 + 对话级键，**不清空 store、不拼接旧消息** */
  openDialogue(input: { dialogueId: string; goal: string }): Result<void>;
  /** 组件切换：**只**写边界键（不重置上下文） */
  markComponentBoundary(componentId: string): Result<void>;
  /** 按输入集切可见子范围；回合段按变更频率升序 */
  assemble(
    sel: ContextSelector,
    input: {
      history: ChatMessagePort[];
      upstream: Record<string, unknown>;
      events: unknown[];
      env?: unknown;
    },
  ): Result<Observation>;
  /** 子件可见面必须是宿主的**真**子集（不得等于宿主全集，也不得越权） */
  assertSubsetOfHost(
    child: ContextSelector,
    host: ContextSelector,
  ): Result<void>;
  /** 工具区一致性（同一 agent 内所有组件必须一致） */
  assertToolZoneConsistent(hash: string): Result<void>;
  /** pull 类数据：受**频率约束**（不得每轮拉取） */
  pullShared(
    domain: "l1" | "coop" | "system",
    reader: SharedReader,
  ): Promise<Result<ReadonlyArray<{ key: string; content: string }>>>;
  diagnostics(): {
    constantHash: string | null;
    sectionKeys: string[];
    order: string[];
  };
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

export function createContextAssembler(
  deps: ContextAssemblerDeps,
): ContextAssembler {
  const now = deps.now ?? (() => Date.now());
  const pullMinIntervalMs = deps.pullMinIntervalMs ?? 30_000;

  let constantHash: string | null = null;
  let toolZoneHash: string | null = null;
  /** key → 声明（用于排序与可见面判定） */
  const specs = new Map<string, SectionSpec>();
  /** 域 → 上次拉取时刻 */
  const lastPullAt = new Map<string, number>();

  function put(key: string, content: string): void {
    deps.store.put({ key, content, timestamp: now() });
  }

  return {
    applyConstantZone(staticPrompt, toolNames) {
      const payload = JSON.stringify({
        staticPrompt,
        toolNames: [...toolNames].sort(),
      });
      const h = hashOf(payload);
      if (constantHash === null) {
        constantHash = h;
        // 恒定区作为**会话级**分区写入（变更频率 0 = 最稳定，排最前）
        specs.set("ctx:zone:static", {
          key: "ctx:zone:static",
          content: staticPrompt,
          changeFreq: 0,
          scope: "session",
        });
        put("ctx:zone:static", staticPrompt);
        specs.set("ctx:zone:tools", {
          key: "ctx:zone:tools",
          content: JSON.stringify([...toolNames].sort()),
          changeFreq: 0,
          scope: "session",
        });
        put("ctx:zone:tools", JSON.stringify([...toolNames].sort()));
        return ok({ hash: h });
      }
      if (h !== constantHash) {
        // ★ 规则 1：恒定区漂移 ⇒ 拒绝（工具区在 messages 之前，一变则全部前缀失效）
        return err(
          "恒定区发生漂移（跨对话哈希不一致）：期望 " +
            constantHash +
            "，实际 " +
            h,
        );
      }
      return ok({ hash: h });
    },

    putSection(spec) {
      specs.set(spec.key, spec);
      put(spec.key, spec.content);
      return ok(undefined);
    },

    openDialogue(input) {
      // ★ 规则 3：只写边界键与对话级键；**不清空 store**、不回写历史
      put(
        BOUNDARY_KEY_DIALOGUE,
        JSON.stringify({ dialogueId: input.dialogueId, at: now() }),
      );
      specs.set(BOUNDARY_KEY_DIALOGUE, {
        key: BOUNDARY_KEY_DIALOGUE,
        content: input.dialogueId,
        changeFreq: 1,
        scope: "dialogue",
      });
      put(KEY_DIALOGUE_GOAL, input.goal);
      specs.set(KEY_DIALOGUE_GOAL, {
        key: KEY_DIALOGUE_GOAL,
        content: input.goal,
        changeFreq: 2,
        scope: "dialogue",
      });
      return ok(undefined);
    },

    markComponentBoundary(componentId) {
      // ★ 规则 3：组件切换**只**写边界键（不重置上下文）
      put(BOUNDARY_KEY_COMPONENT, JSON.stringify({ componentId, at: now() }));
      specs.set(BOUNDARY_KEY_COMPONENT, {
        key: BOUNDARY_KEY_COMPONENT,
        content: componentId,
        changeFreq: 3,
        scope: "component",
      });
      return ok(undefined);
    },

    assemble(sel, input) {
      for (const k of sel.sections) {
        if (!specs.has(k) && !deps.store.get(k)) {
          return err("输入集声明了未注册的分区: " + k);
        }
      }
      // 只取**声明**的子范围，并按变更频率升序（稳定的在前）
      const ordered = sel.sections
        .map((k) => ({
          key: k,
          freq: specs.get(k)?.changeFreq ?? Number.MAX_SAFE_INTEGER,
        }))
        .sort((a, b) => a.freq - b.freq)
        .map((x) => x.key);
      const contextSections = ordered
        .map((k) => {
          const s = deps.store.get(k);
          return s ? { key: k, content: s.content } : null;
        })
        .filter((x): x is { key: string; content: string } => x !== null);

      const history =
        sel.history === "all"
          ? [...input.history]
          : input.history.slice(
              Math.max(0, input.history.length - sel.history.recentTurns),
            );

      return ok({
        contextSections,
        history,
        upstream: input.upstream,
        events: input.events,
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
    },

    assertSubsetOfHost(child, host) {
      const extra = child.sections.filter((k) => !host.sections.includes(k));
      if (extra.length > 0) {
        return err("子件可见面越权（宿主未声明的分区）: " + extra.join(","));
      }
      if (sameSet(child.sections, host.sections)) {
        // ★ 规则 4：等于宿主全集 ⇒ 拒绝（嵌套退化为"看全部"）
        return err("子件输入集不得等于宿主全集（嵌套退化，冲突域隔离失效）");
      }
      return ok(undefined);
    },

    assertToolZoneConsistent(hash) {
      if (toolZoneHash === null) {
        toolZoneHash = hash;
        return ok(undefined);
      }
      if (toolZoneHash !== hash) {
        return err(
          "同一 agent 内工具区不一致（组件切换会使前缀失效）：期望 " +
            toolZoneHash +
            "，实际 " +
            hash,
        );
      }
      return ok(undefined);
    },

    async pullShared(domain, reader) {
      const last = lastPullAt.get(domain);
      const t = now();
      if (last !== undefined && t - last < pullMinIntervalMs) {
        return err(
          "拉取过于频繁：域 " +
            domain +
            " 距上次仅 " +
            (t - last) +
            "ms（最小间隔 " +
            pullMinIntervalMs +
            "ms）",
        );
      }
      const res = await reader(domain);
      if (!res.ok) return res;
      lastPullAt.set(domain, t);
      return res;
    },

    diagnostics() {
      return {
        constantHash,
        sectionKeys: [...specs.keys()],
        order: [...specs.values()]
          .sort((a, b) => a.changeFreq - b.changeFreq)
          .map((s) => s.key),
      };
    },
  };
}
