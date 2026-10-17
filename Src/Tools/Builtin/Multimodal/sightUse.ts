/**
 * 视觉工具 SightUse（多模态路径 a：文本主模型 + 视觉工具）
 *
 * 设计依据：用户裁定（2026-10-14）——多模态两条确定路径：
 *   (a) 文本主模型经**视觉工具**操作图像；(b) 多模态模型原生内容块。
 * 本工具落地 (a)：把图像作为内容块交给**声明了 supports_vision 的模型**，
 * 由工具层返回文本结论；主模型自身不需要视觉能力。
 *
 * 边界（避免伪造能力）：
 * - 未注册任何 supports_vision 模型 → `VISION_UNAVAILABLE`（可恢复）；
 * - 指定模型未声明视觉 → `VISION_UNSUPPORTED`（配置错误，不可恢复）；
 * - 图像读取/供应商调用失败 → 如实返回错误码，不返回伪造描述。
 */

import { readFile } from "node:fs/promises";

import type { ToolDefinition } from "../../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../../Traits/toolSpec.js";
import { contentOutputSchema } from "../_shared.js";
import {
  getRegisteredModels,
  resolveModel,
  supportsVision,
} from "../../../Infra/Llm/Router/modelRouter.js";

const ALL_ROLES = [
  "prime_director",
  "arbitrator",
  "auditor",
  "partner",
  "worker",
  "assembly_node",
  "reviewer",
  "regulator",
] as const;

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 把图像入参规范化为内容块可用的 URL（本地路径 → data URL）。 */
async function toImageUrl(
  image: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  if (/^(https?:|data:)/i.test(image)) return { ok: true, url: image };
  try {
    const bytes = await readFile(image);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `图像过大（${bytes.byteLength} 字节 > ${MAX_IMAGE_BYTES}）`,
      };
    }
    const lower = image.toLowerCase();
    const ext = lower.endsWith(".png")
      ? "png"
      : lower.endsWith(".webp")
        ? "webp"
        : lower.endsWith(".gif")
          ? "gif"
          : "jpeg";
    return {
      ok: true,
      url: `data:image/${ext};base64,${bytes.toString("base64")}`,
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 选视觉模型：显式指定优先，否则取第一个声明 supports_vision 的已注册模型。 */
function pickVisionModel(
  explicit?: string,
): { ok: true; model: string } | { ok: false; code: string; reason: string } {
  if (explicit) {
    const resolved = resolveModel(explicit);
    if (!resolved.ok)
      return { ok: false, code: "MODEL_NOT_FOUND", reason: resolved.error };
    if (!supportsVision(explicit)) {
      return {
        ok: false,
        code: "VISION_UNSUPPORTED",
        reason: `模型 ${explicit} 未声明 supports_vision，不能用于视觉工具`,
      };
    }
    return { ok: true, model: explicit };
  }
  const candidates = getRegisteredModels().filter((m) => supportsVision(m));
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "VISION_UNAVAILABLE",
      reason:
        "未注册任何声明 supports_vision 的模型（请先在模型供应商中配置视觉模型）",
    };
  }
  return { ok: true, model: candidates[0] as string };
}

export const sightUse: ToolDefinition = {
  spec: {
    name: "SightUse",
    version: "0.1.0",
    description:
      "用视觉模型看懂一张图片并回答关于它的问题（多模态路径 a：文本主模型 + 视觉工具）。",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "图片路径或 http(s)/data URL" },
        prompt: { type: "string", description: "要问图片的问题 / 任务描述" },
        model: {
          type: "string",
          description: "可选：指定视觉模型全限定名（provider/model）",
        },
      },
      required: ["image", "prompt"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema("{ text: string, model: string }"),
    dangerLevel: "SAFE",
    // 模型调用非确定（同一图/问可能给不同回答）且会消耗外部配额 ⇒ 非幂等
    idempotency: "NO",
    reversibility: "REVERSIBLE",
    // 非幂等工具不得声明 none（不变量）：视觉工具会发起外部模型调用
    sideEffectScope: "external",
    requiredRoles: [...ALL_ROLES],
    sandboxMode: "none",
    timeoutMs: 60_000,
  },

  async execute(input, context) {
    const image = typeof input["image"] === "string" ? input["image"] : "";
    const prompt = typeof input["prompt"] === "string" ? input["prompt"] : "";
    const explicitModel =
      typeof input["model"] === "string" ? input["model"] : undefined;
    if (!image)
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 image 参数",
        false,
      );
    if (!prompt)
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 prompt 参数",
        false,
      );

    const picked = pickVisionModel(explicitModel);
    if (!picked.ok) {
      return toolError(
        context.operationId,
        picked.code,
        picked.reason,
        picked.code !== "VISION_UNSUPPORTED",
      );
    }

    const resolved = resolveModel(picked.model);
    if (!resolved.ok) {
      return toolError(
        context.operationId,
        "MODEL_NOT_FOUND",
        resolved.error,
        false,
      );
    }

    const imageUrl = await toImageUrl(image);
    if (!imageUrl.ok) {
      return toolError(
        context.operationId,
        "IMAGE_READ_FAILED",
        imageUrl.reason,
        true,
      );
    }

    const provider = resolved.value.provider;
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageUrl.url } },
        ],
      },
    ];
    const options = {
      model: resolved.value.spec.id,
      messages,
      max_tokens: 1024,
    } as unknown as Parameters<typeof provider.chat>[0];

    try {
      const result = await provider.chat(options);
      if (!result.ok) {
        return toolError(
          context.operationId,
          "VISION_CALL_FAILED",
          result.error,
          true,
        );
      }
      const content = (result.value as { content?: unknown }).content;
      const text = typeof content === "string" ? content : "";
      if (!text) {
        return toolError(
          context.operationId,
          "VISION_EMPTY_RESPONSE",
          "视觉模型返回空内容",
          true,
        );
      }
      return toolSuccess(context.operationId, { text, model: picked.model });
    } catch (e) {
      return toolError(
        context.operationId,
        "VISION_CALL_FAILED",
        e instanceof Error ? e.message : String(e),
        true,
      );
    }
  },
};
