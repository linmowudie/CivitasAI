/**
 * tool.search —— 工具探索（**追加式工具**的发现入口）。
 *
 * 存在意义（设计依据：MongoTerminalAgent v2.0）：
 *  头部 `tools` 必须冻结，因此 Agent 无法"一开始就看到全部工具"。
 *  本工具按关键词返回匹配工具的 **schema 摘要**，内容包括：
 *  名称 / 描述 / 危险级 / 参数结构 / 是否已在头部。
 *  返回值作为**工具结果追加到消息尾部**（不进入头部），
 *  因此新工具进入视野**不会破坏前缀缓存**；随后用 `tool.execute` 调用。
 */
import type { ToolDefinition } from '../../Traits/toolSpec.js';
import { toolSuccess, toolError } from '../../Traits/toolSpec.js';
import { contentOutputSchema } from '../_shared.js';
import { searchToolSpecs, listDiscoverableSpecs } from '../../Registry/toolHeader.js';
import type { UserRole } from '../../../Infra/types.js';

export const toolSearcher: ToolDefinition = {
  spec: {
    name: 'tool.search',
    version: '0.1.0',
    description:
      '探索可用工具：按关键词/用途/类别检索工具的**名称、描述与参数结构**。'
      + '需要某类能力（如"写入文件""搜索代码""执行命令"）而当前工具列表里没有时，'
      + '先用本工具查找，再用 tool.execute 执行。传空 query 可列出尚未在头部注入的工具。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词 / 用途 / 类别（如 write、搜索、shell）' },
        limit: { type: 'number', description: '返回条数（默认 5，最多 20）' },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: contentOutputSchema('{ query, matched, tools: Array<{ name, description, dangerLevel, parameters, inHeader }> }'),
    dangerLevel: 'SAFE',
    idempotency: 'YES',
    idempotencyKeyFields: ['query', 'limit'],
    reversibility: 'REVERSIBLE',
    sideEffectScope: 'none',
    requiredRoles: ['prime_director', 'arbitrator', 'auditor', 'partner', 'worker', 'assembly_node', 'reviewer', 'regulator'],
    sandboxMode: 'none',
    timeoutMs: 5_000,
  },

  async execute(input, context) {
    const query = String(input['query'] ?? '').trim();
    const rawLimit = input['limit'];
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      return toolError(context.operationId, 'INVALID_INPUT', 'limit 必须是 1..20 的整数', false);
    }

    const role = context.agentRole as UserRole;
    let matched = searchToolSpecs(query, role, limit);

    // 空查询的语义：列出"头部之外、尚未注入"的工具（帮助 Agent 发现增量能力）
    if (query === '') {
      matched = listDiscoverableSpecs(role).slice(0, limit).map((spec) => ({
        name: spec.name,
        description: spec.description,
        dangerLevel: spec.dangerLevel,
        parameters: spec.inputSchema,
        inHeader: false,
      }));
    }

    return toolSuccess(context.operationId, JSON.stringify({
      query,
      matched: matched.length,
      tools: matched,
      hint: matched.length === 0
        ? '未找到匹配工具；可尝试更宽的关键词或空 query 查看可发现工具'
        : '用 tool.execute(name, arguments) 执行其中的工具（DANGEROUS 级需直接调用以便审批）',
    }, null, 2));
  },
};
