---
description: "后台记忆整理：回合结束后提取并保存耐久事实的整理遍，以及按间隔闸门的整作用域合并遍，两者均为工具受限的 purpose:memory 辅助请求"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-curation

[English](README.md) | 中文

记忆子系统的后台写入侧：在成功完成的回合之后，把会话重放给一次辅助模型调用以保存耐久事实；并按独立调度合并某个作用域的全部条目——两者都位于默认关闭的 `memory` 设置开关之后。

## 概述

`dsh-memory-curation` 是一个函数插件（`name = 'memory-curation'`，`inject = ['memory']`）。一个 `session/event` 监听器随事件提交逐步折叠每个回合的事实；在 `turn/end` 观察到 `completed` 原因时，它快照重放前缀并按会话入队一个合并遍——一个在跑、至多一个待决——该遍可运行**提取**（审查已完成的会话中值得保存的耐久事实）与**合并**（对整个作用域做合并去重）。两者都作为 `purpose: 'memory'` 请求执行、重放会话前缀以复用 KV 缓存，仅对 `ctx.memory` 执行四个记忆工具、使用带来源标记的写者，并把进度游标持久化在 memory 域中。

## 目录

- [配置](#configuration)
- [提取](#extraction)
- [合并](#consolidation)
- [受限工具循环](#the-restricted-tool-loop)
- [游标与归属](#cursors-and-attribution)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

功能开关位于 `memory` 设置命名空间（`extraction`、`consolidation`——均默认关闭）；下列字段调节调度与写入预算。

| 字段 | 类型 | 默认值 | 边界 |
|---|---|---|---|
| `extractionMaxWrites` | 整数 | `4` | 1–20（单次提取遍可提交的 `memory_save`/`memory_delete` 数） |
| `maxToolRounds` | 整数 | `8` | 1–24（一遍内的模型请求数） |
| `consolidationMaxWrites` | 整数 | `8` | 1–40（单次合并运行可提交的 `memory_save`/`memory_delete` 数） |
| `consolidationMinChanges` | 整数 | `6` | 1–1000（重新武装一次运行所需的已提交作用域变更数） |
| `consolidationIntervalMs` | 整数 | `86400000` | 60000–2592000000（同一作用域两次运行的最小间隔） |

<a id="extraction"></a>
## 提取

在以 `reason.kind === 'completed'` 观察到的 `turn/end` 上，满足以下任一条件即跳过：

- `extraction` 开关关闭、会话是委派的（`delegationDepthOf(agent) > 0`）、或无法找到会话的 agent；
- 该回合的折叠中没有携带至少三个信号词的人类撰写 `user/message`（空白分隔词元加每个汉字各计一个单位——一个词的回答永不触发复审），或已出现 `memory_save`/`memory_delete` 的 `tool/call`——已经自我整理过的回合无需再审；
- `ctx.memory.scopesFor(agent)` 不提供任何可写作用域，或——`project` 空间下——`authorize('memory')` 拒绝，该检查发生在**首次模型调用之前**；
- 没有 `llm` 服务或无法解析 provider/model（每会话警告一次）；
- 会话的耐久提取游标已经到达该 `turn/end` 的 seq——被中断的遍会在下次重审同一片段。

否则，重放前缀加上逐字提取指令（内插当前目录与写入上限）作为一次 `purpose: 'memory'` 请求流式发出；模型驱动下文的受限工具循环。提取游标仅在循环完成后提交，因此被取消或失败的遍会在下次重审同一片段。

<a id="consolidation"></a>
## 合并

每次遍还会对 `scopesFor(agent)` 提供的每个作用域做三重闸门判定——`lastRunAt` 早于 `consolidationIntervalMs`、`changedSince` 达到 `consolidationMinChanges` 次已提交变更（服务在每次已提交写入内部递增该计数）、以及作用域 `[key, summary, content]` 元组的 sha256 内容摘要与上次运行不同——并对每个合格的作用域运行一次整作用域遍。合并请求是一条独立消息（不重放会话），携带逐字指令与该作用域的完整目录；其写者来源为 `consolidation`。游标——`lastRunAt`、`lastDigest`、`changedSince: 0`——仅在该运行的写入落地后提交，因此对未变化内容的重复运行什么都不做，被中断的运行会自行重新武装。

<a id="the-restricted-tool-loop"></a>
## 受限工具循环

两个遍共享同一个有界循环：流式发出一次请求、执行 `tool-call` 块、把结果回喂、重复，直至模型停止调用工具或 `maxToolRounds` 触发。每次请求都按模型公开的最低推理档位并封顶 5,000 输出 token——辅助调用姿态，而非会话调好的设置。只有 `memory_search`、`memory_read`、`memory_save`、`memory_delete` 可执行——对其他工具的调用以错误结果回给模型——每次保存/删除都计入该遍的写入预算。写入经 `ctx.memory.save`/`delete`、以 `{ kind: 'agent', agent, source }` 写者完成，因此服务的校验、作用域准入、project 授权与串行写链全部依旧生效；`execution/forbidden` 拒绝以错误结果呈现给模型而不是抛出 `RemoteError`。取消会中止流，且遍在其信号触发后不发布任何游标。

<a id="cursors-and-attribution"></a>
## 游标与归属

两条耐久游标记录存放在 memory 域的 `cursors` 表（服务仍是唯一写入者）：`extraction-{sessionId}` 保存 `lastSeq`；`consolidation-{scopeId}` 保存 `lastRunAt`、`lastDigest` 与 `changedSince`。每次写入在 `updated` 归属中标记 `source` 为 `extraction` 或 `consolidation`、发起会话 id，以及——project 空间下——由 `executionIdentity` 携带的已授权主操作者 user id。

<a id="invariants"></a>
## 不变式

**运行时不变式：** 不发布伴生检查。该遍完全从已提交的会话事件、会话表面投影与耐久的 memory 域状态推导；它不持有可供不变式比较的私有索引。

<a id="model-experience"></a>
## 模型体验

### 提取请求

#### What the model sees

会话自身的重放前缀（系统头、表面消息、请求头工具）加一条用户角色指令消息：逐字提取文本、列出当前条目的 `<saved_memory_catalog>` 块、作用域规则与写入上限——以"一行列出你写入的记忆键，或一行 'no memories saved'"收尾。模型按会话工具教会它的方式作答并调用记忆工具。

#### Token effect

每个合格的已完成回合一次请求加至多 `maxToolRounds` 轮工具调用；开关关闭、回合没有人类输入、回合已写过记忆、或游标已覆盖时完全跳过；写入以 `extractionMaxWrites` 为上限。

#### KV Cache effect

请求逐字重放会话最近的请求前缀——推导消息加请求头的工具列表——provider 前缀缓存可命中共享头部；只有追加的指令与工具轮次是新 token。重放的工具列表保持会话自身的样子以保证缓存保真，而可执行集合仍是四个记忆工具。

### 合并请求

#### What the model sees

一条独立的用户角色消息：逐字合并文本点名作用域、`<saved_memory_catalog>` 块列出该作用域全部条目、写入上限——以逐行动作行或 "no changes" 收尾。可见工具被限制为四个记忆 schema。

#### Token effect

每个合格作用域一次请求加工具轮次，闸门的存在让安静的作用域零成本：未达 `consolidationMinChanges`、未过 `consolidationIntervalMs`、或内容摘要未变，都意味着零调用。

#### KV Cache effect

独立提示词不与会话共享前缀，但在作用域内容变化前逐字重复——目录块顺序确定，因此未变化作用域的请求字节稳定、跨遍缓存友好。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **提取只审查重放的表面** — 被压缩掉的回合没有贡献；游标仍会越过它们，因为审查只能看到幸存的内容。
- **每会话至多一个遍在跑** — 第二个完成的回合排在第一个之后并合并；快速连续回合合并成一个待决快照而非一遍一次。
- **选择器与写者是同一个模型** — 提取质量取决于会话模型在有界循环内的判断；没有专用的整理模型或人工复核。
- **合并等待会话到来** — 闸门只有在遍运行时才会触发；无人重访的作用域即使过了间隔也不会被合并。
- **不做跨作用域合并** — 每次合并遍只看到一个作用域；personal/workspace 之间的重复条目要等到各自作用域的遍来处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

- `session/event` 是折叠来源：回合事实随已提交事件到达，`turn/end` 从不扫描历史；重放前缀在触发时读取 `deriveMessages()`/`requestHeader()`/`toolHistory()`。
- lane 映射是每会话一个 `AbortController`——会话处置与插件卸载都会中止它；`drive` 中的 `finally` 会排空待决快照，使入队回合的遍仍会运行。
- 写者 `signal` 搭载在 `MemoryWriter` 上，使 `save`/`delete` 内部的 project 授权观察到与模型流相同的取消。

</details>
