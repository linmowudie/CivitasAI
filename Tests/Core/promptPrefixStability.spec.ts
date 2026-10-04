/**
 * 前缀稳定性回归测试（缓存友好性）。
 *
 * 背景：项目提供商侧按**前缀缓存**计费/加速 —— 请求的前缀只要有一个字节变化，
 * 从该点起的缓存全部失效。MongoTerminalAgent v2.0 的实测结论是"前缀稳定 >90%"，
 * 其做法见 `Core/PromptConstruction/PromptBuilder.py`：**三区分离**（静态段 / 会话段 /
 * 回合段，每轮变化的必须排最后）+ **同内容跳过、同键原位替换** + 工具头部冻结。
 *
 * 本测试把该原则固化为可执行门禁：
 *  ① 同一工具集（即使传入顺序不同）→ 系统提示**字节一致**；
 *  ② 工具数组按名称确定性排序（前缀不因注册表顺序抖动）；
 *  ③ 模拟多轮对话（每轮追加消息，工具集保持稳定）→ **前缀稳定度 ≥ 90%**；
 *  ④ 系统提示静态段不含易变内容（时间戳/计数/目录列表）。
 */
import { describe, it, expect } from 'vitest';
import { buildStableSystemPrompt, resetSystemPromptCache } from '../../Src/Core/Loop/runIteration.js';

/** 最长公共前缀长度（按字符） */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** 前缀稳定度：连续两次请求之间，公共前缀占较短者的比例 */
function prefixStability(prev: string, next: string): number {
  const min = Math.min(prev.length, next.length);
  if (min === 0) return 0;
  return commonPrefixLength(prev, next) / min;
}

/** 模拟"提供商看到的请求"：system 消息 + tools 参数（JSON 序列化，键序固定） */
function requestShape(systemPrompt: string, tools: Array<{ name: string; description: string }>): string {
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    system: systemPrompt,
    tools: sortedTools.map(t => ({ type: 'function', function: { name: t.name, description: t.description } })),
  });
}

/** 旧构造：工具数组未排序（复刻改造前的行为，仅用于对比测量） */
function requestShapeLegacy(systemPrompt: string, tools: Array<{ name: string; description: string }>): string {
  return JSON.stringify({
    system: systemPrompt,
    tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description } })),
  });
}

const TOOLS = [
  { name: 'dir.list', description: '列出目录' },
  { name: 'file.read', description: '读取文件' },
  { name: 'file.write', description: '写入文件' },
  { name: 'todo.write', description: '维护计划' },
  { name: 'shell.exec', description: '执行命令' },
];

describe('前缀稳定性（缓存友好）', () => {
  it('① 同一工具集（传入顺序不同）→ 系统提示字节一致', () => {
    resetSystemPromptCache();
    const a = buildStableSystemPrompt(TOOLS.map(t => t.name));
    resetSystemPromptCache(); // 连缓存也清掉，验证的是"确定性"而非"缓存命中"
    const shuffled = [...TOOLS.map(t => t.name)].reverse();
    const b = buildStableSystemPrompt(shuffled);
    expect(a).toBe(b);
  });

  it('② 工具数组顺序确定：与传入顺序无关', () => {
    const orderA = [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)).map(t => t.name);
    const orderB = [...TOOLS].reverse().sort((a, b) => a.name.localeCompare(b.name)).map(t => t.name);
    expect(orderA).toEqual(orderB);
    // 系统提示里"可用工具"目录也必须是排序后的（只解析该小节，避免把约束条目误当工具行）
    const prompt = buildStableSystemPrompt([...TOOLS.map(t => t.name)].reverse());
    const catalogSection = prompt.split('## Available tools')[1] ?? '';
    const listed = catalogSection.split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim());
    expect(listed).toEqual(orderA);
  });

  it('③ 模拟 5 轮对话 → 前缀稳定度 ≥ 90%', () => {
    resetSystemPromptCache();
    const systemPrompt = buildStableSystemPrompt(TOOLS.map(t => t.name));
    const shapes: string[] = [requestShape(systemPrompt, TOOLS)];

    // 每轮只**追加**消息（历史不重写），工具集与系统提示保持冻结
    let history = '';
    for (let turn = 1; turn <= 5; turn++) {
      history += JSON.stringify({ role: 'user', content: `第 ${turn} 轮用户输入` });
      history += JSON.stringify({ role: 'assistant', content: `第 ${turn} 轮回复（含工具调用与结果）` });
      shapes.push(`{"system":${JSON.stringify(systemPrompt)},"tools":${JSON.stringify(
        [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({ type: 'function', function: { name: t.name, description: t.description } })),
      )},"messages":${JSON.stringify(history)}}`);
    }

    const ratios: number[] = [];
    for (let i = 1; i < shapes.length; i++) ratios.push(prefixStability(shapes[i - 1]!, shapes[i]!));
    const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;

    // 诊断输出（便于观察真实数字，不参与断言）
    console.log('  每轮前缀稳定度:', ratios.map(r => `${(r * 100).toFixed(1)}%`).join(' → '), `｜均值 ${(avg * 100).toFixed(1)}%`);

    expect(avg).toBeGreaterThanOrEqual(0.9);

    // ── 改造前对比（重建旧构造方式，用于量化收益；旧代码已删除，故在此复刻）──
    const legacyPrompt = `You are Civitas-AI, an autonomous agent system. You have access to the following tools. Use them when appropriate to complete tasks.

Available tools:
${TOOLS.map(s => `- ${s.name}: ${s.description}`).join('\n')}`;
    const legacyShapes: string[] = [requestShapeLegacy(legacyPrompt, TOOLS)];
    let legacyHistory = '';
    for (let turn = 1; turn <= 5; turn++) {
      legacyHistory += JSON.stringify({ role: 'user', content: `第 ${turn} 轮用户输入` });
      legacyHistory += JSON.stringify({ role: 'assistant', content: `第 ${turn} 轮回复（含工具调用与结果）` });
      legacyShapes.push(`{"system":${JSON.stringify(legacyPrompt)},"tools":${JSON.stringify(TOOLS)},"messages":${JSON.stringify(legacyHistory)}}`);
    }
    const legacyRatios: number[] = [];
    for (let i = 1; i < legacyShapes.length; i++) legacyRatios.push(prefixStability(legacyShapes[i - 1]!, legacyShapes[i]!));
    const legacyAvg = legacyRatios.reduce((s, r) => s + r, 0) / legacyRatios.length;
    console.log(`  对比：旧构造 ${(legacyAvg * 100).toFixed(1)}% → 新构造 ${(avg * 100).toFixed(1)}%`);
    expect(avg).toBeGreaterThanOrEqual(legacyAvg); // 不应更差（本例中工具顺序被固定，故应更优或持平）
  });

  it('④ 静态段不含易变内容（时间戳/计数/逐条工具描述）', () => {
    const prompt = buildStableSystemPrompt(TOOLS.map(t => t.name));
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO 时间戳
    expect(prompt).not.toMatch(/\d{13}/);                        // epoch ms
    // 工具目录只有名称 + 统一提示，不再逐条内联描述（描述体积大且随实现变化）
    expect(prompt).toContain('Tool schemas are provided through the API');
    for (const t of TOOLS) expect(prompt).not.toContain(t.description);
  });

  it('⑤ FE-052 角色段：原文置于系统提示最前且带分隔；同角色同工具集字节一致', () => {
    resetSystemPromptCache();
    const rolePrompt = '# Worker — 执行者\n\n## 身份\n你是 Worker。';
    const a = buildStableSystemPrompt(TOOLS.map(t => t.name), rolePrompt);
    resetSystemPromptCache(); // 连缓存也清掉，验证的是"确定性"而非"缓存命中"
    const b = buildStableSystemPrompt([...TOOLS.map(t => t.name)].reverse(), rolePrompt);
    expect(a).toBe(b);
    expect(a.startsWith(rolePrompt.trim())).toBe(true);
    expect(a).toContain('---');
    expect(a).toContain('You are Civitas-AI'); // 通用静态段仍在其后

    // 未传角色段 → 与旧行为一致（以静态段开头，向后兼容）
    const noRole = buildStableSystemPrompt(TOOLS.map(t => t.name));
    expect(noRole.startsWith('You are Civitas-AI')).toBe(true);
  });

  it('⑥ FE-052 缓存按角色隔离：同工具集不同角色段互不命中', () => {
    resetSystemPromptCache();
    const p1 = buildStableSystemPrompt(TOOLS.map(t => t.name), '角色甲');
    const p2 = buildStableSystemPrompt(TOOLS.map(t => t.name), '角色乙'); // 同工具集、不同角色
    const p3 = buildStableSystemPrompt(TOOLS.map(t => t.name), '角色甲'); // 应命中缓存
    expect(p1).not.toBe(p2);
    expect(p1).toBe(p3);
    expect(p1.startsWith('角色甲')).toBe(true);
    expect(p2.startsWith('角色乙')).toBe(true);
  });
});
