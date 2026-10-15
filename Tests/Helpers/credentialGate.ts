/**
 * @module Tests/Helpers/credentialGate
 * @description
 * 真实凭据门禁 —— 落实九系统检验方案 §2.2 **反假绿铁律 1**：
 *
 * > **缺 Key 记 FAIL 或 NOT-RUN，不记 SKIP-pass。**
 *
 * 问题原貌：本仓 13 处"缺 key 即 `console.log('SKIP'); return;`"的用例，
 * 在 vitest 眼里是**通过**（`return` 不是失败）。于是一个从未真正调用过真实模型的
 * 用例，计入的却是"通过"，并被算进"单 Agent 端到端已覆盖"——**假绿**。
 *
 * 本模块的处理：
 *  1. `hasRealLlmKey()` 统一判定（有 key 才真跑）；
 *  2. `notRun()` 把该用例登记为 **NOT-RUN**（写旁路标记文件 + 醒目告警），
 *     它既不是 FAIL（CI 无 key 不该红），也**绝不是 PASS**；
 *  3. `Scripts/credentialNotRun.cjs` 汇总标记，产出 NOT-RUN 清单并计入落地率分母。
 *
 * 为什么不直接 `it.skipIf(...)`：那需要改动 13 处 `it(...)` 声明（分散在 5 个文件、
 * 多种签名），且 skip 态无法携带"缺哪个凭据"的信息。旁路标记既不动用例结构，
 * 又能给出可汇总的结构化记录。
 */

import { expect } from "vitest";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 真实模型调用所需的凭据（唯一受门禁的凭据） */
export const REAL_LLM_ENV = "HUAWEI_MAAS_API_KEY";

/** NOT-RUN 标记文件（可由环境变量覆盖；默认落在 Benchmarks/baselines 下） */
const MARKER_FILE =
  process.env["BENCH_NOTRUN_FILE"] ??
  resolve(import.meta.dirname, "../../Benchmarks/baselines/notRun.raw.jsonl");

/** 是否具备真实调用凭据 */
export function hasRealLlmKey(): boolean {
  const v = process.env[REAL_LLM_ENV];
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * 把当前用例登记为 **NOT-RUN**（缺凭据，未真正执行其被测行为）。
 *
 * 必须在 `return` 之前调用；调用后仍应 `return`，让用例体不执行。
 *
 * @param label 用例名（省略时自动取 vitest 的 currentTestName）
 */
export function notRun(label?: string): void {
  let name = label;
  try {
    const state = expect.getState() as { currentTestName?: string };
    name = state.currentTestName ?? label;
  } catch {
    /* 取不到就用传入的 label */
  }
  const resolved = name ?? "(未命名用例)";

  // 醒目告警：让 vitest 输出里也能看见"这条不是通过，是没跑"
  console.warn(
    `[NOT-RUN] ${resolved} —— ${REAL_LLM_ENV} 未设置，被测行为未执行（不计为通过）`,
  );

  try {
    mkdirSync(dirname(MARKER_FILE), { recursive: true });
    appendFileSync(
      MARKER_FILE,
      JSON.stringify({
        test: resolved,
        credential: REAL_LLM_ENV,
        at: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
  } catch {
    /* 标记写失败不应让用例变红；汇总脚本会发现清单缺失并如实报告 */
  }
}
