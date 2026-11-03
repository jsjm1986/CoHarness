---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-query

[English](README.md) | 中文

位于 `ctx.sessionQuery` 之上、经工作区授权的模型工具。该 opt-in 包只依赖统一接口，并注册 `session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_handoff` 和 `session_event_read`；`standard` 代理预设会挂载它。

## 概述

使用 `dsh-tool-session-query` 可让模型搜索既往会话、检查事件匹配、追踪会话或事件关系，并读取精确事件数据。它的六个只读工具返回无游标文本；只有目标会话的 `cwd` 与调用方完全相等时才允许跨会话访问。组合了 `collaboration` 服务时，每个跨会话目标还必须出现在绑定参与方的 `readableSessionIds` 集合中；没有绑定主体的轮次会拒绝一切跨会话目标。搜索会排除调用方会话，并在达到结果上限时要求模型缩小查询。`standard` 预设挂载本包，每次模型请求会增加固定指引与六个工具 schema。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxSearchResults` | `100` | 在内部提供方分页中收集的最大已授权非自身命中数 |
| `searchTimeoutMs` | `30000` | 附加到两个全文搜索工具的协作式截止时间 |
| `handoffChars` | `24000` | 单次续接简报本地尾部的字符预算 |
| `handoffExtraction` | `true` | 是否允许辅助模型将界面压缩为 capsule |
| `handoffExtractChars` | `60000` | 超过该序列化对话上限时跳过提取 |
| `handoffTimeoutMs` | `120000` | 单次续接调用（含提取）的协作式截止时间 |

调用方只能来自 `ToolExecution.exec.agent`。跨会话访问要求目标和调用方会话的 `cwd` 值严格相等；没有 `cwd` 的调用方只能检查自己。组合了 `collaboration` 服务时，跨会话 id 还必须出现在每个操作阶段一次批量 `collaboration.capture().readableSessionIds` 调用返回的参与方可读集合中；`capture()` 失败——没有绑定请求主体的环境轮次——只授权调用方自己的会话。

全部异步读取完成后，每个操作会一次性批量复核其披露的所有跨会话 id 的当前可读性；权限撤销会拒绝整个结果，不返回已读内容。Handoff 还会在辅助模型提取前与提取完成后检查。操作开始时已组合 collaboration，而其提供方在最终检查前消失时，操作同样拒绝跨会话输出。自身访问与未组合 collaboration 的组合保留既有规则。

搜索绝不公开提供方游标、偏移、分页大小或模型可控上限。由于一次搜索会在内部消费与世代绑定的提供方游标，两个搜索工具都与同级工具调用排他执行；三个精确跟踪/读取工具选择并行执行。每个精确执行器都将未更改的执行信号传递给授权和服务跟踪/读取，因此取消会等待协作式持久化清理，并保留信号的精确原因。工具边界上的时间戳要求显式 `Z` 或数字偏移，并转换为包含端点的 epoch 毫秒过滤器。

`session_search` 始终省略调用方会话。请求的父 id 会被去重，并在 FTS 前根据调用方工作区权限——以及协作组合时的可读集合——检查；只有已授权 id 会到达提供方，而缺失、跨工作区和不可读猜测的行为完全相同，root 标记仍独立使用 OR。当前会话中的 `session_event_search` 会在调用它的步骤之前立即停止，因此当前 assistant 输出和已记录工具调用无法匹配自身。直接目标在跟踪、事件或标题读取前完成授权。血缘输出会用不含隐藏会话 id 的标记替换未授权祖先和后代边界；在共享项目工作区中，同样的遮蔽覆盖调用方不可读的成员会话。`session_handoff` 对已授权会话当前界面的末尾做续接简报：投影直接的用户与 assistant 对话、保留压缩检查点，返回字符受限的本地尾部，或在 `llm` 服务与路由目标可解析时返回单个辅助模型 capsule（涵盖目标、决策、文件、状态与下一步）；非空 capsule 必须以正常的 `stop` 结束。提供方错误、提供方取消、输出 token 耗尽、工具调用结束、缺失结束状态、空提取、界面超限、服务缺失或开关关闭都会回退到本地尾部。调用方取消与交接截止时间仍终止操作；披露内容前继续复核权限。

每次辅助提取会在打开模型流之前，向调用方 Session 追加仅日志可见的 `session/handoff-llm-request`。它保留已授权的源 Session、请求的提供方／模型及完整输入消息，并按字面保留源文本。提供方默认值仍在现有流内解析；输入记录不声明提供方特定的 HTTP 请求体。输入记录失败会返回本地尾部，不派发模型请求。新增必读事件遵循[交接输入升级指南](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/session-handoff-input/guide.zh.md)。

每个可信 `ctx.sessionQuery` 调用都会经过一个模型边界净化器。首先检查调用方取消，并精确保留。可获取的语料库诊断信息和提供方诊断信息（包括可安全检查的嵌套原因）会尽力记录到内部日志；不可打印的失败使用固定日志占位符。诊断格式化和错误分类各自独立受保护，因此不可打印的原因无法逃逸，也无法阻止已安全分类的外层错误；不安全的分类或日志记录则回退到固定 `SESSION_QUERY_TOOL_FAILED` 代码和消息。本地参数验证和授权错误保留精确的工具自有消息。

该包刻意不执行字节或字符截断，也不导入 spill 后端。需要限制内联输出的部署应挂载 `@deepseek-ai/dsh-spill-policy`，它可在执行后替换已渲染文本，同时保留完整结果。

跨会话读取会在提供方不可用期间保留[应用授权要求](../../context/collaboration/README.zh.md#application-authorization)。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

模型会收到一个固定的既往历史指引章节。

##### 既往历史指引

```markdown
Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.
```

#### Token 影响

插件挂载期间，每次请求都存在一个固定精简章节。

#### KV Cache 影响

插件与指引文本不变时，前缀稳定。

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_handoff` 与 `session_event_read` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-session-query)。搜索过滤器会增加固定 schema token，而游标、工作区路径、输出分页与模型可控结果上限仍不存在。

#### Token 影响

可见期间，每次请求都会发送六个固定只读 schema。

#### KV Cache 影响

工具可见性与定义不变时，前缀稳定。

### 工具结果

#### 模型看到什么

每次成功调用都会发出一个纯文本块。搜索结果包含标题与最佳匹配摘录；追踪包含全部已授权关系；事件读取包含未经删节的目标 JSON。通用 spill 策略可以用其预览、不透明定位信息与取回指引替换过大的内联文本。

#### Token 影响

结果取决于数据，并保留在已记录工具历史中直到压缩（compaction）；`maxSearchResults` 限制搜索命中数。

#### KV Cache 影响

仅追加的结果文本位于可重用请求前缀之后，不会使较早的缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 搜索最多返回部署上限，匹配更多时会请模型缩小查询；不提供延续 token。
- 工作区身份使用保守的字符串精确 `cwd` 相等性，因此符号链接等价的路径不共享权限。
- 未挂载通用 spill 策略的自定义组合会以内联方式接收完整跟踪和事件载荷。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
