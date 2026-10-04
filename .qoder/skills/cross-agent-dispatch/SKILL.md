---
name: cross-agent-dispatch
description: 通过 ComputerUse 跨应用调度任务给其他 AI Agent IDE（DeepSeek Harness、Cursor、Windsurf 等），并接收执行结果。当用户要求向另一个 Agent 发送任务、跨 IDE 协作、或远程操作不支持网络连接的 Agent 时使用。Use when user says "交给 XX harness/agent/IDE 执行" or "让 XX 做这件事".
---

# Cross-Agent Dispatch

通过桌面自动化（ComputerUse）将任务委派给本地运行的其他 AI Agent IDE，并回收结果。

## 前置条件

- 目标 Agent IDE 已在用户桌面启动
- ComputerUse Agent 可用（通过 `Agent` 工具 + `subagent_type: ComputerUse`）
- 目标 IDE 有对话/聊天输入界面

## 调度流程

### 1. 构造 ComputerUse 任务描述

向 `Agent` 工具传入以下结构化 prompt：

```
你需要通过 Computer Use 操控用户桌面上的 [目标 IDE 名称] 窗口，向其 AI Agent 输入任务。

## 目标窗口识别
- 窗口标题包含：[关键词，如 "DeepSeek"、"Cursor"]
- 进程路径：[如已知，填 D:\XXX\app.exe；未知则省略]

## 任务内容
在对话输入框中输入以下消息并发送：

---
[完整的任务指令文本]
---

## 操作步骤
1. 在任务栏或桌面找到目标窗口，激活到前台
2. 截图确认当前界面状态
3. 定位对话输入框（查找 placeholder 文本、多行文本框、或带发送按钮的输入区域）
4. 点击输入框获取焦点
5. 使用 type_text 输入任务消息（不要使用 clipboard 粘贴，确保逐字输入）
6. 按 Enter 或点击发送按钮
7. 等待 3-5 秒后截图，确认 Agent 已开始处理
8. 返回截图路径和处理状态
```

### 2. 调用 ComputerUse Agent

```
Agent({
  description: "向 [IDE名] 发送任务",
  subagent_type: "ComputerUse",
  prompt: <上面构造的任务描述>
})
```

### 3. 回收结果

ComputerUse Agent 返回后：
- 提取截图路径 → 用 `Read` 查看截图确认状态
- 提取执行状态（是否成功输入、Agent 是否开始处理）
- 如需等待结果 → 再次调用 ComputerUse 截取后续输出

## 输入框定位策略

按优先级尝试：

| 策略 | 方法 | 适用场景 |
|------|------|----------|
| UIA text 匹配 | `element_text` 匹配 placeholder（如"发消息"、"Ask anything"） | 大多数现代 IDE |
| 角色匹配 | `element_role` 查找 `multiline_text` 或 `edit` | 通用 |
| 视觉定位 | 截图 → 识别底部/右侧输入区域 → 点击坐标 | 兜底方案 |

常见 IDE 输入框特征：

- **DeepSeek Harness**: placeholder "发消息或创建任务, / 调用指令, @ 文件或对话"
- **Cursor**: placeholder "Ask anything..." 或底部 Composer 区域
- **Windsurf**: 类似 ChatGPT 风格的底部输入框
- **VS Code + Copilot**: 侧边栏 Chat 面板

## 多 Agent 并行调度

需要同时调度多个 Agent 时，**串行调用** ComputerUse（每个 Agent 独占桌面焦点）：

```
# 1. 先发给 Agent A
Agent({ subagent_type: "ComputerUse", prompt: "发给 Agent A 的任务..." })

# 2. 再发给 Agent B
Agent({ subagent_type: "ComputerUse", prompt: "发给 Agent B 的任务..." })
```

不要并行调用——桌面焦点同一时刻只能属于一个窗口。

## 结果回收模式

### 即时确认（默认）
发送后等待 3-5 秒截图，确认 Agent 已开始输出。

### 延迟回收
对于长时间任务，设置等待策略：

```
## 回收步骤
1. 等待 30 秒（让 Agent 处理）
2. 切回目标窗口（可能在处理期间失去焦点）
3. 截图查看输出区域
4. 如果 Agent 仍在输出（状态栏有速度/步数显示），再等 30 秒重复
5. 如果输出完成（出现最终结果/代码块/总结），截取完整结果
6. 返回结果文本和截图路径
```

### 滚动捕获
长结果需要滚动截取：

```
## 滚动捕获
1. 在输出区域截图
2. 使用 Page Down 键或鼠标滚轮向下滚动
3. 再次截图
4. 重复直到看到结束标记（如 "Done"、最终代码块、或滚动到底部）
```

## 错误处理

| 问题 | 处理 |
|------|------|
| 找不到窗口 | 检查任务栏所有窗口，截图桌面全景，让用户确认窗口位置 |
| 输入框无法定位 | 尝试 Tab 键导航，或点击窗口后使用 Ctrl+L / Ctrl+K 等快捷键聚焦 |
| 输入被截断 | 分段输入：每段 ≤200 字符，段间暂停 0.5s |
| Agent 无响应 | 检查是否需要先登录、是否有网络错误，截图反馈给用户 |
| 窗口被遮挡 | 使用 Alt+Tab 切换，或最小化其他窗口 |

## Electron webview 限制（已知缺陷）

**Electron 应用的 contenteditable 输入框无法通过 ComputerUse 自动化。**

根因：Electron webview 内部的 contenteditable div 虽然暴露在 UIA 树中，但：
- 不暴露 ValuePattern → set_value 失败
- UIA Focus 无法穿透 webview 边界 → 键盘事件被主窗口消费
- 鼠标点击被 webview 渲染层拦截 → 不映射到 DOM 元素
- 剪贴板粘贴（Ctrl+V）同样无效 → 元素未获得 DOM 焦点

**受影响的 IDE**：DeepSeek Harness（已验证）、其他基于 Electron + webview 的 Agent IDE

**不受影响的 IDE**：原生 UI 框架（WPF/Qt/SwiftUI）构建的 IDE，或输入框是原生控件的应用

### 降级方案

当目标 IDE 是 Electron webview 时：

1. **Chrome DevTools Protocol**：如果 Electron 启动时带了 `--remote-debugging-port`，可通过 CDP 直接操作 DOM
2. **剪贴板 + 用户辅助**：将任务文本复制到剪贴板，请用户手动 Ctrl+V 粘贴
3. **直接 API 调用**：如果目标 Agent 操作的对象有 HTTP API，直接调用 API 而非通过 IDE
4. **Electron IPC**：如果目标应用暴露了 IPC 通道，通过 IPC 发送消息

## 注意事项

- **不要假设 API 可用**：目标 Agent 是桌面应用，只能通过 UI 交互
- **输入速度**：type_text 比人类快，某些 IDE 可能有输入节流，注意观察是否丢字
- **焦点管理**：每次操作前确认目标窗口在前台
- **截图验证**：每个关键步骤后截图，不要盲操作
- **中文输入**：type_text 对中文支持良好，无需特殊处理
- **Electron 应用**：先尝试一次 type_text 验证输入框可接收文本，如果失败立即切换降级方案，不要反复重试
