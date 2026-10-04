/**
 * @module Core/Model/contextHistory
 * @description
 * 对话上下文历史装配——把 DB 中的原始消息行整理成送入模型的 messages。
 *
 * 产品决策：**暂停 / 中断的消息如何进入上下文**
 * - 用户消息已发出、模型已产出**部分**回复后暂停 → 该助手消息保留在上下文中（部分回复仍有价值）；
 * - 模型**尚未产出任何内容**就暂停 → 该轮不得写入上下文：
 *   1. 空白 / 纯空格的 assistant 消息一律过滤（不产生"空助手轮次"）；
 *   2. 由此，**发了消息却始终没得到回复**的历史 user 消息（悬空 user）会被剔除，
 *      避免模型面对一串未回答的请求而答错对象；
 *   3. 唯一例外是**最后一条**消息——它正是本轮要回答的请求，必须保留。
 *
 * 重要约束：主循环的提示词只由 `systemPrompt + chatMessages` 组成
 * （见 Src/Core/Loop/runIteration.ts 的 messages 装配），
 * 当前用户消息不会通过 userInput 额外追加，因此最后一条 user 消息绝不能被过滤掉。
 */

/** 参与上下文装配的最小消息形状 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** 内容是否为空（含仅空白） */
function isBlank(content: string | null | undefined): boolean {
  return (content ?? '').trim() === '';
}

/**
 * 该 user 消息之后是否紧跟一条非空 assistant 回复。
 * 若先遇到下一条 user 消息（或到达末尾），视为未回复。
 */
function isAnswered(rows: readonly ContextMessage[], index: number): boolean {
  for (let j = index + 1; j < rows.length; j++) {
    const role = rows[j]!.role;
    if (role === 'user') return false;
    if (role === 'assistant') return true; // 空 assistant 已在前一步过滤
  }
  return false;
}

/**
 * 装配送入模型的对话历史。
 *
 * @param rows 按时间升序排列的会话消息
 * @returns 过滤后的消息序列（保持原相对顺序）
 */
export function buildContextHistory(rows: readonly ContextMessage[]): ContextMessage[] {
  // ① 过滤空白 assistant：模型未产出内容就暂停的轮次不进入上下文
  const cleaned = rows.filter(
    (r) => !(r.role === 'assistant' && isBlank(r.content)),
  );

  // ② 剔除悬空 user（历史中"未回复就暂停"的请求），最后一条除外
  const out: ContextMessage[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const row = cleaned[i]!;
    const isLast = i === cleaned.length - 1;
    if (row.role === 'user' && !isLast && !isAnswered(cleaned, i)) {
      continue;
    }
    out.push(row);
  }
  return out;
}
