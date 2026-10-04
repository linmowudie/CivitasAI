# 【交给 Qoder 执行】工具统一派发 / 追加式上下文 / 头部冻结 —— 详细实现提示词

> **⚠️ 本文档由 AI 编码代理（DeepSeek Harness Agent）创建，非人工编写，也非既有设计文档的一部分。**
> 创建时间：2026-10-03 21:45 ｜ 归属目录：`Docs/Dev/`
> 用途：**交给 Qoder 执行**的详细实现提示词（Qoder 侧模型能力有限，故本文件把路径、符号、代码骨架、
> 测试用例、验收命令、易错点全部写死；请逐条照做，不要自由发挥）。
> 若 Qoder 正在整理文档体系，请把本文档视为外部新增产物，保留本署名块。

---

## 0. 一句话目标

把「**工具头部冻结（前缀缓存友好）+ 追加式工具探索 + 统一派发收口 + 工具耗时透出 + 热工具配置化 + 追加式上下文接线**」收尾，
使：**会话内 `tools` 头部字节恒定、所有工具调用都经单一收口、界面能看到工具耗时、新工具经探索追加而不破坏缓存前缀**。

---

## 1. 执行前必读（硬约束）

1. **不要**把全部工具塞回 `tools` 头部（那会破坏前缀缓存，是本任务的反面目标）。
2. **不要**让 `DANGEROUS` 工具经 `tool.execute` 执行（会绕过审批红线）。
3. **不要**改动既有设计文档的**结构/章节编号**，只允许**追加小节**（见 T5）。
4. **必须**保持既有测试全绿；新增行为必须**新增测试**，不允许删改既有断言来"通过"。
5. 提交前**必须**跑完 §5 的全部门禁命令，并把输出贴到交付报告里。
6. 代码风格：ESM + TypeScript 严格模式；注释用中文，写**为什么**（不要写"做了什么"）；不要引入新依赖。

### 1.1 一组"踩过的坑"（务必避免）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| PowerShell 双引号里写 `\n` | 文件里出现**字面** `\n` 而非换行 | 用编辑工具写多行，或 PowerShell 单引号 + 真实换行 |
| SQLite 迁移版本号撞号 | 版本号记录了但**列没建**（静默跳过） | 新迁移用**未被占用**的最大版本号（当前已到 **v28**，下一步用 **v29**） |
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | SQLite 语法错误、启动失败 | SQLite 用普通 `ADD COLUMN`；`down` 必须真正能回滚 |
| better-sqlite3 绑定布尔值 | `SQLite3 can only bind numbers, strings...` | 显式绑 `0` / `1` |
| `createEvent(EventType.X, payload)` | 类型报错 | 本项目是**单对象**：`createEvent({ eventType, source, payload })` |
| `err('x', 'ERROR')` | 参数个数错误 | 本地 `Infra/types.ts` 的 `err` 只有**一个**参数 |
| zod schema 未声明的字段 | 字段被**静默剥离** | 只要上游会传，就必须在 schema 里显式声明 |
| `apiPost` 失败不抛错 | 静默丢数据 | 必须检查 `res.ok` 并 `console.warn` |
| 迁移/主进程改动 | 不重启不生效 | `Src/**` 改动需 `npm run build:server` + 重启 Electron |

---

## 2. 背景：已完成的部分（**不要重做**）

以下已由 DeepSeek Harness Agent 实现并测试通过，Qoder 只需在此基础上收尾：

| 文件 | 已实现内容 |
|---|---|
| `Src/Tools/Registry/toolHeader.ts` | `buildToolHeader(role)` 头部冻结（热工具 + 元工具，按名排序）；`listDiscoverableSpecs(role)`；`searchToolSpecs(query, role, limit)`；常量 `DEFAULT_HOT_TOOLS`、`META_TOOLS` |
| `Src/Tools/Registry/toolDispatcher.ts` | `dispatchToolCall({ toolName, arguments, context, iteration })` → `{ result, text, durationMs, errorClass }`；`normalizeToolContent(content)` |
| `Src/Tools/Builtin/System/toolExecutor.ts` | 元工具 `tool.execute`（CONTROLLED；仅允许 SAFE/CONTROLLED；禁止递归） |
| `Src/Tools/Builtin/System/toolSearcher.ts` | 元工具 `tool.search`（SAFE；返回工具 schema 摘要供追加到上下文） |
| `Src/Core/Loop/runIteration.ts` | 头部改用 `buildToolHeader(ctx.agentRole)`；系统提示三区分离 + 工具数组排序（`buildStableSystemPrompt`） |
| `Tests/Tools/toolHeaderDispatch.spec.ts` | 8 项测试（头部冻结/探索/派发/安全边界/归一/错误分类） |
| `Tests/Core/promptPrefixStability.spec.ts` | 4 项测试（前缀稳定 ≥90%，实测 99.9%） |

---

## 3. 任务清单

### T1 —— 工具调用**全面收口**到统一派发器

**问题**：`Src/Core/Loop/runIteration.ts` 内层仍直接调用 `executeTool(...)`，只有 `tool.execute` 走了派发器 → 审计与耗时口径不一致。

**改动**：`Src/Core/Loop/runIteration.ts`

1. 找到内层工具执行处（`executeWrapHooks<ToolCallInput, ToolCallOutput>('wrapToolCall', ...)` 的最后一个 `async (input) => {...}` 回调），其中有：
   ```ts
   const result = await executeTool(input.toolName, input.arguments, toolCtx);
   return { status: result.status, content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), recoverable: result.recoverable };
   ```
2. 改为经派发器，并把耗时带出去：
   ```ts
   const outcome = await dispatchToolCall({
     toolName: input.toolName,
     arguments: input.arguments,
     context: toolCtx,
     iteration: ctx.currentIteration,
   });
   // 记录本轮耗时，供事件 payload 与界面展示（T2）
   lastToolDurationMs = outcome.durationMs;
   return { status: outcome.result.status, content: outcome.text, recoverable: outcome.result.recoverable };
   ```
   - `lastToolDurationMs` 在 `toolCtx` 构造之前声明（`let lastToolDurationMs = 0;`），并在 `ctx.onToolCallResult?.({...})` 里加上 `durationMs: lastToolDurationMs`（T2 会消费该字段）。
3. 顶部 import：`import { dispatchToolCall } from '../../Tools/Registry/toolDispatcher.js';`
   **若 `executeTool` 不再被本文件使用，请删除其 import**（否则 `tsc` 会报 `TS6133` 未使用变量）。

**约束**：`toolCtx`（`ToolExecutionContext`）必须保持原样传入（含 `operationId/agentId/agentRole/loopId/traceId/signal/sessionId/workDir`）——派发器依赖它做角色门与审计。

**测试**：`Tests/Tools/toolDispatchWiring.spec.ts`（新建）
- 断言 `runIteration.ts` 源码中**不再**直接出现 `await executeTool(`（可用读文件 + 正则断言，简单可靠）；
- 断言源码中**出现** `dispatchToolCall(` 且其调用带 `iteration` 字段。

---

### T2 —— 工具耗时（`durationMs`）透出到界面

**目标**：工具卡片能显示"耗时 12ms"。

**改动 1（后端事件 payload）**：`Src/Core/Loop/runIteration.ts`
- `IterationContext.onToolCallResult` 的**类型定义**新增可选字段：
  ```ts
  /** 本次工具执行耗时（ms），由统一派发器产出（T1） */
  durationMs?: number;
  ```
- 调用处（`ctx.onToolCallResult?.({...})`）补 `durationMs: lastToolDurationMs`。

**改动 2（IPC 事件发布）**：`Src/Interface/IpcBridge/ipcBridge.ts`
- `onToolCallResult` 回调里，`AGENT_TOOL_CALL_RESULT` 的 payload 补：
  ```ts
  durationMs: info.durationMs ?? null,
  ```
- **注意**：`onIterationComplete` 里 `toolResults` 的映射也建议补 `durationMs`（若该结构里能拿到；拿不到就保持 `null`，不要伪造）。

**改动 3（前端事件类型与 store）**：
- `Client/src/hooks/useEventBus.ts`：`AGENT_TOOL_CALL_RESULT` 分支的数据类型加 `durationMs?: number | null`，并透传给 store：
  ```ts
  useChatStore.getState().applyToolCallResult(data.messageId, {
    toolCallId: data.toolCallId,
    status: data.status,
    content: data.content,
    error: data.error,
    durationMs: data.durationMs ?? undefined,
  });
  ```
- `Client/src/stores/chatStore.ts`：
  - `ToolCallEntry` 接口新增 `durationMs?: number`；
  - `applyToolCallResult` 的 `data` 形参类型加 `durationMs?: number`，并在 `patch()` 里写入：
    ```ts
    ? { ...tc, status: data.status, content: data.content, error: data.error, ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}) }
    ```
  - **落库字段**：`persistMessageRich` 会把 `toolCalls` 原样落库（已支持），无需改 SQL；但请确认 `hydrateRichMessage` 不会把 `durationMs` 丢掉（它目前是整体透传，通常无需改；若做了字段白名单，请加入 `durationMs`）。

**改动 4（界面展示）**：`Client/src/ai-components/harness/ToolGroup.tsx`
- 在工具名/状态之后显示耗时（**仅在成功/失败且有值时**显示，避免"生成中"显示耗时）：
  ```tsx
  {tc.status !== 'generating' && tc.status !== 'pending' && typeof tc.durationMs === 'number' && (
    <span className="text-[10px] text-text-muted flex-shrink-0">{tc.durationMs} ms</span>
  )}
  ```
- 文案统一用 `ms`（与派发器单位一致），不要写成"毫秒"混排。

**测试**：`Tests/Client/tool-duration.spec.ts`（新建，`@vitest-environment jsdom`）
- `applyToolCallResult` 写入 `durationMs` 后，`ToolCallEntry.durationMs === 123`；
- 未传 `durationMs` 时，条目**不新增**该字段（避免 `undefined` 落库）。

---

### T3 —— 热工具清单**配置化**（但同一会话内恒定）

**目标**：可通过配置调整头部热工具集合；缺省回退到代码常量；**同一会话内不得变化**。

**改动 1（配置文件）**：新建 `Configs/tools.json`
```json
{
  "tools": {
    "comment": "工具头部（tools 参数）冻结集：只放高频热工具 + 元工具。同一会话内必须保持恒定，否则会破坏提供商前缀缓存。",
    "hot": [
      "file.read", "file.write", "file.edit",
      "dir.list", "file.grep", "shell.exec",
      "todo.write", "web.search",
      "tool.search", "tool.execute"
    ],
    "maxHeaderTools": 12
  }
}
```
> **注意**：`tool.search` / `tool.execute` 是元工具，必须始终在头部；即使配置漏写，`buildToolHeader` 也会自动补上（已实现）。
> `maxHeaderTools` 用于兜底：若 `hot` 写超了，按名称排序取前 N 个并在日志里 `warn`。

**改动 2（加载与注入）**：`Src/main.ts`
- 启动期读取（与既有 `durable` 配置同风格）：
  ```ts
  const toolsConfig = getConfigValueOr<Record<string, unknown>>(config, 'tools', {});
  const hot = Array.isArray(toolsConfig['hot']) ? toolsConfig['hot'].map(String) : undefined;
  const maxHeaderTools = typeof toolsConfig['maxHeaderTools'] === 'number' ? toolsConfig['maxHeaderTools'] : undefined;
  setToolHeaderConfig({ hotTools: hot, maxHeaderTools });
  ```
- 在 `Src/Tools/Registry/toolHeader.ts` 中新增并导出：
  ```ts
  let headerConfig: { hotTools?: readonly string[]; maxHeaderTools?: number } = {};
  /** 启动期注入（配置驱动）；**禁止**在会话运行中调用，否则头部会抖动、破坏前缀缓存 */
  export function setToolHeaderConfig(cfg: { hotTools?: readonly string[]; maxHeaderTools?: number }): void { headerConfig = { ...cfg }; }
  ```
  并让 `buildToolHeader` 使用 `options.hotTools ?? headerConfig.hotTools ?? DEFAULT_HOT_TOOLS`，最后按 `headerConfig.maxHeaderTools` 截断（元工具优先保留）。

**测试**：`Tests/Tools/toolHeaderConfig.spec.ts`（新建）
- 注入自定义 `hot` 后，`buildToolHeader` 只返回该集合 ∩（角色可见）∪元工具；
- `maxHeaderTools=3` 时，返回条数 ≤ 3 且**元工具仍在内**；
- 未注入时为默认集合（与 `DEFAULT_HOT_TOOLS` 一致）。

---

### T4 —— 追加式上下文（ContextStore 语义）接线

**目标**：把"同键同内容 → 跳过；同键不同内容 → **原位替换**；新键 → **追加**"落到 `runIteration`，
替换当前的 TODO 降级路径（直接使用 `ctx.chatMessages`），从而：**每轮变化的上下文只追加到尾部，前缀保持稳定**。

**改动 1（新建）**：`Src/Services/Context/contextStore.ts`（语义参照 MongoTerminalAgent v2.0 `ContextModels.py`）
```ts
export interface ContextSection {
  /** 唯一键，形如 `ctx:P1:file:main.ts:a3f2`；同键代表"同一主题的最新内容" */
  key: string;
  content: string;
  timestamp: number;
}

/** 追加式上下文集合：保证"键→内容"的**位置稳定** */
export class ContextStore {
  private sections = new Map<string, ContextSection>();   // Map 保持插入顺序
  /** @returns true=发生变更（新增/替换）；false=跳过（同键同内容） */
  put(section: ContextSection): boolean;
  remove(key: string): boolean;
  get(key: string): ContextSection | undefined;
  keys(): string[];
  /** 增量：自 knownKeys 以来新增的分区与已删除的键 */
  diffSince(knownKeys: string[]): { added: ContextSection[]; removedKeys: string[] };
  /** 转成追加式消息（role: 'system'，内容前缀 `[ctx:<key>] `） */
  toAppendMessages(): Array<{ role: 'system'; content: string }>;
  clear(): void;
}
/** 消息指纹（role + 内容前 300 字符），用于去重校验 */
export function messageFingerprint(role: string, content: string): string;
```
实现要求：
- `put`：键已存在且内容**完全相同** → 返回 `false` 且**不改动位置**；内容不同 → 替换内容（位置不变）并返回 `true`；新键 → 追加末尾返回 `true`。
- 内容做 `trim()` 后再比较（避免空白差异导致误判"变更"）。
- 指纹用 `node:crypto` 的 `sha256` 取前 16 位十六进制（**不要**自己写哈希）。

**改动 2（接入 `runIteration`）**：`Src/Core/Loop/runIteration.ts`
- `IterationContext` 新增可选字段：`contextStore?: ContextStore;`
- 构造 `messages` 时，把追加段放在**历史之后**（顺序：`system`（静态提示）→ 历史 → **追加的 `[ctx:…]` 段**）：
  ```ts
  const appended = ctx.contextStore ? ctx.contextStore.toAppendMessages() : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...ctx.chatMessages.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })),
    ...appended.map(m => ({ role: 'system' as const, content: m.content })),
  ];
  ```
- **删除**该处 `// TODO: 当 PartitionState 完整初始化后，启用 assembleContext 装配路径` 注释，改为说明"追加式上下文已接线；四层分区装配见 Services/Context/assembler.ts（后续）"。
- **不要**把追加段插到 `systemPrompt` 之前（那会破坏前缀缓存）。

**测试**：`Tests/Services/contextStore.spec.ts`（新建）
- 同键同内容 → `put` 返回 `false`，`keys()` 顺序不变；
- 同键不同内容 → 返回 `true`，**位置不变**（keys 顺序一致），内容已更新；
- 新键 → 追加到末尾；
- `diffSince([...])` 正确返回新增与删除；
- `toAppendMessages()` 的消息内容以 `[ctx:<key>] ` 开头；
- **前缀稳定**：模拟 5 轮，每轮 `put` 一个变化的键 → 计算"每轮 messages 序列化后的最长公共前缀 / 较短者" **≥ 90%**（参照 `Tests/Core/promptPrefixStability.spec.ts` 的 `commonPrefixLength` 写法）。

---

### T5 —— 文档更新（**只追加，不改结构**）

1. `Docs/Agent/10-配置体系与安全/配置体系与安全设计.md`
   - 在 **§6 v2 补丁** 之后追加一节：`### 6.x 工具头部冻结与统一派发（2026-10-03）`
   - 必须写清三条红线：
     1. 头部只放热工具 + 元工具（`tool.search` / `tool.execute`），**会话内字节恒定**；
     2. 新工具经 `tool.search` 探索、schema 作为**工具结果追加到上下文**，**不进头部**（保护前缀缓存）；
     3. **`DANGEROUS` 工具不得经 `tool.execute` 执行**（否则安全门看不到它、无法审批）——必须直接调用。
   - 同时把 `Configs/tools.json → tools.hot / maxHeaderTools` 加入该文档的配置项汇总（§2）。

2. `Docs/Agent/07-共享记忆与上下文系统/共享记忆与上下文系统设计.md`
   - **仅修正过期校准注**：`§2.1 / §3.1` 中"`long_term_memory` 只存内存 Map、重启即丢"的说法**已过期**
     —— `Src/Services/SharedMemory/longTermMemoryStore.ts` 已真实读写该表（含 `owner_user_id`）。
     请改为现态描述并注明"2026-10-03 校准更新"。**不要**删除原校准注，追加更新说明即可。
   - `global_workspace` 仍**无任何 SQL 读写**（仅迁移建表）——该条校准**仍然成立**，请勿改动。

3. `Docs/Dev/多智能体系统设计验证清单.md`（本 Agent 创建的矩阵）
   - 完成后把相应行的 **状态** 改为 `✅通过` / `🔧已修复待复核`，把 **date time** 改为完成时间；
   - 在 **§3 证据记录** 追加一行：命令 + 关键输出 + 结论。
   - **不要**改这张表的结构（7 列固定：来源｜状态｜问题｜关于客户端｜关于Agent｜关于服务端｜date time）。

---

## 4. 交付报告格式（必须包含）

1. **改动文件清单**（路径 + 一句话改动）；
2. **每条任务（T1–T5）的完成证据**：命令 + 关键输出（不要只写"已实现"）；
3. **门禁输出**（§5 全部命令的结论行）；
4. **新增测试清单**（文件名 + 用例数 + 全绿截图/输出）；
5. **未完成/存疑项**：如遇到无法解决的点，**写入** `Docs/Dev/多智能体系统设计验证清单.md` 对应行（不要只在对话里说明）。

---

## 5. 统一验收（全部必须通过）

```bash
# ① 四套类型门禁（必须全部 0 错误）
npx tsc --noEmit                                  # 根
cd Client && npx tsc --noEmit && cd ..            # 客户端
npm run typecheck:electron                        # Electron 主进程/preload
cd Server && npx tsc --noEmit && cd ..            # 服务端

# ② 测试（根：当前基线 1049 通过 / 74 文件，只允许增加，不允许减少）
npx vitest run

# ③ 服务端测试（真实 PostgreSQL；TEST_DATABASE_URL 指向本地测试库）
cd Server && TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/civitas_server_test npx vitest run

# ④ 构建（主进程/Src 改动必须重建，否则运行的不是新代码）
npm run build:server
```

**额外验收（机制层面，必须自查并在报告中给出数字）**：
1. 头部规模：`buildToolHeader('prime_director').length ≤ 12`，且**元工具在头部**；
2. 前缀稳定：`Tests/Core/promptPrefixStability.spec.ts` 与 T4 新增用例均 ≥ 90%；
3. 收口验证：全仓搜索 `await executeTool(`，**只允许**出现在 `Src/Tools/Registry/toolDispatcher.ts` 内；
4. 安全边界：`Tests/Tools/toolHeaderDispatch.spec.ts` 的"⑤ DANGEROUS 禁止借壳"必须仍通过。

---

## 6. 明确**不要**做的事

- 不要把 `getVisibleToolsForRole` 的结果直接塞回 `tools` 头部（本任务的核心约束）。
- 不要为了"通过测试"而修改 `Tests/Tools/toolHeaderDispatch.spec.ts`、`Tests/Core/promptPrefixStability.spec.ts` 的既有断言。
- 不要引入新的第三方依赖（含工具库/哈希库）。
- 不要改 `runIteration` 中系统提示的**分区顺序**（静态段 → 工具目录 → 回合段）。
- 不要把追加式上下文插到系统提示之前。
- 不要动 `Docs/Server/**` 与 `Docs/Client/**` 的既有结构（只在 §T5 指定的位置追加）。
