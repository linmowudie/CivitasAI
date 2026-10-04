/**
 * @module Core/Middleware/toolCallClassifier
 * @description
 * ToolCall 子类型与危险等级推断——Docs/Client/03 §2.1。
 *
 * 当后端工具注册表未显式声明 `subgroup` / `riskLevel` 时，
 * 通过工具名和参数推断前端渲染所需的分类信息。
 */

// ── 工具子类型 ──────────────────────────────────────────────────────

export type ToolSubgroup = 'read' | 'write' | 'exec' | 'system';

/**
 * 根据工具名推断子类型（Docs/Client/03 §2.1 规则）
 *
 * | 前缀/模式 | 子类型 |
 * |---|---|
 * | read_*, list_*, get_*, search_*, find_* | read |
 * | write_*, create_*, update_*, delete_*, remove_* | write |
 * | exec_*, bash_*, run_*, execute_* | exec |
 * | 其他 | system |
 */
export function inferSubgroup(toolName: string): ToolSubgroup {
  const name = toolName.toLowerCase();
  if (name.startsWith('read_') || name.startsWith('list_') || name.startsWith('get_') ||
      name.startsWith('search_') || name.startsWith('find_')) {
    return 'read';
  }
  if (name.startsWith('write_') || name.startsWith('create_') || name.startsWith('update_') ||
      name.startsWith('delete_') || name.startsWith('remove_')) {
    return 'write';
  }
  if (name.startsWith('exec_') || name.startsWith('bash_') || name.startsWith('run_') ||
      name.startsWith('execute_')) {
    return 'exec';
  }
  return 'system';
}

// ── 危险等级 ────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 根据工具名和参数推断危险等级（Docs/Client/03 §2.1 规则）
 *
 * | 等级 | 判定条件 |
 * |---|---|
 * | low | 只读操作，无副作用 |
 * | medium | 写入用户文件，可撤销 |
 * | high | 系统级修改，需谨慎 |
 * | critical | 不可逆操作，需审批 |
 */
export function assessRiskLevel(toolName: string, _args?: Record<string, unknown>): RiskLevel {
  const name = toolName.toLowerCase();

  // critical: 不可逆操作
  if (name.includes('delete') || name.includes('drop') || name.includes('destroy') ||
      name.includes('format') || name.includes('truncate')) {
    return 'critical';
  }

  // high: 系统级修改
  if (name.startsWith('exec_') || name.startsWith('bash_') || name.startsWith('run_') ||
      name.startsWith('execute_') || name.includes('install') || name.includes('system')) {
    return 'high';
  }

  // medium: 写入操作
  if (name.startsWith('write_') || name.startsWith('create_') || name.startsWith('update_') ||
      name.startsWith('remove_') || name.startsWith('move_') || name.startsWith('copy_')) {
    return 'medium';
  }

  // low: 只读操作
  return 'low';
}
