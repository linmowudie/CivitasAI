/**
 * 网络搜索工具（SAFE）——FE-067 实装（替代“恒空成功”桩）。
 *
 * 真相（修复前）：无论输入如何都返回 `{ results: [], message: '…桩实现…' }`——
 * 模型收到“成功但零结果”，无任何失败信号，可能据空数据继续推理（静默错误语义）。
 *
 * 现行为：
 *  - 配置 `CIVITAS_WEB_SEARCH_API_KEY`（或 `SERPER_API_KEY`）→ 真实调用搜索 API
 *    （Serper 兼容：`POST {endpoint}/search`，`X-API-KEY` 鉴权，取 `organic[]`）；
 *  - 未配置 → fail-closed `NOT_ENABLED`（诚实失败，绝不伪造成功）；
 *  - 端点可用 `CIVITAS_WEB_SEARCH_ENDPOINT` 覆盖（缺省 https://google.serper.dev）。
 */

import type { ToolDefinition } from "../../Traits/toolSpec.js";
import { toolSuccess, toolError } from "../../Traits/toolSpec.js";
import { contentOutputSchema } from "../_shared.js";
import { isNetworkAllowed } from "../../../Infra/Security/whitelist.js";
import { logger } from "../../../Infra/Logging/logger.js";

const DEFAULT_ENDPOINT = "https://google.serper.dev";
const TIMEOUT_MS = 10_000;

interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
}

export const webSearch: ToolDefinition = {
  spec: {
    name: "WebSearch",
    version: "0.2.0",
    description:
      "通过搜索引擎查询互联网信息，返回标题、链接与摘要。" +
      "未配置搜索服务时返回 NOT_ENABLED（请勿将失败当作“无结果”）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        maxResults: {
          type: "number",
          description: "最大结果数，默认 5（1-10）",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema(
      "{ query, count, results: Array<{title, url, snippet}> }",
    ),
    dangerLevel: "SAFE",
    idempotency: "YES",
    idempotencyKeyFields: ["query", "maxResults"],
    reversibility: "REVERSIBLE",
    sideEffectScope: "external",
    requiredRoles: [
      "prime_director",
      "arbitrator",
      "auditor",
      "partner",
      "worker",
      "assembly_node",
      "reviewer",
      "regulator",
    ],
    sandboxMode: "none",
    timeoutMs: 15_000,
  },

  async execute(input, context) {
    const query = String(input["query"] ?? "");
    if (!query.trim()) {
      return toolError(
        context.operationId,
        "INVALID_INPUT",
        "缺少 query 参数",
        false,
      );
    }

    const apiKey =
      process.env["CIVITAS_WEB_SEARCH_API_KEY"] ??
      process.env["SERPER_API_KEY"];
    if (!apiKey) {
      return toolError(
        context.operationId,
        "NOT_ENABLED",
        "网络搜索未配置：设置环境变量 CIVITAS_WEB_SEARCH_API_KEY（Serper 兼容服务）后启用",
        false,
      );
    }

    const rawMax = input["maxResults"];
    const maxResults =
      typeof rawMax === "number" && Number.isFinite(rawMax)
        ? Math.min(Math.max(Math.trunc(rawMax), 1), 10)
        : 5;

    const endpoint = (
      process.env["CIVITAS_WEB_SEARCH_ENDPOINT"] ?? DEFAULT_ENDPOINT
    ).replace(/\/+$/, "");

    // 出网白名单（矩阵 cell TOOL-SEC-EGRESS）：联网前必须经 `isNetworkAllowed`。
    // 设计姿态是"空白名单即全禁"（Configs/security.json networkWhitelist 默认为 []），
    // 未命中即拒绝并留痕 —— 绝不"先请求、事后再说"。旧实现直接 fetch，等于绕过整张白名单。
    let hostname = "";
    try {
      hostname = new URL(endpoint).hostname;
    } catch {
      return toolError(
        context.operationId,
        "INVALID_ENDPOINT",
        `搜索端点不是合法 URL: ${endpoint}`,
        false,
      );
    }
    if (!isNetworkAllowed(hostname)) {
      logger.warn("联网工具被网络白名单拒绝", {
        source: "Tools/webSearch",
        toolName: "WebSearch",
        hostname,
        operationId: context.operationId,
        queryLength: query.length,
      });
      return toolError(
        context.operationId,
        "NETWORK_FORBIDDEN",
        `网络白名单未允许 ${hostname}（security.json 的 networkWhitelist 为空时全部禁止）`,
        false,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${endpoint}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return toolError(
          context.operationId,
          "SEARCH_FAILED",
          `搜索服务返回 HTTP ${response.status}`,
          response.status >= 500,
        );
      }

      const data = (await response.json()) as { organic?: SerperOrganicItem[] };
      const organic = Array.isArray(data.organic) ? data.organic : [];
      const results = organic.slice(0, maxResults).map((item) => ({
        title: item.title ?? "",
        url: item.link ?? "",
        snippet: item.snippet ?? "",
      }));

      return toolSuccess(
        context.operationId,
        JSON.stringify(
          {
            query,
            count: results.length,
            results,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "AbortError") {
        return toolError(
          context.operationId,
          "SEARCH_TIMEOUT",
          `搜索超时（${TIMEOUT_MS}ms）`,
          true,
        );
      }
      return toolError(
        context.operationId,
        "SEARCH_FAILED",
        `搜索调用失败：${message}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
