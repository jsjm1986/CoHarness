---
description: "后台记忆整理：回合结束后提取并保存耐久事实的整理遍，以及按间隔闸门的整作用域合并遍，两者均为工具受限的 purpose:memory 辅助请求"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-curation

[English](README.md) | 中文

记忆子系统的后台写入侧：在成功完成的回合之后，把会话重放给一次辅助模型调用以保存耐久事实；并按独立调度合并某个作用域的全部条目——两者都位于默认关闭的 `memory` 设置开关之后。

排队或运行中的记忆整理会通过 `runtime/idle-release-check` 阻止 Host 进程自动释放，直到迭代器清理和已接受的写入完成。主对话轮次结束不表示后台记忆整理已经空闲。

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

功能开关位于 `memory` 设置命名空间（`extraction`、`consolidation`——均默认关闭）；下列字段调节模型输出、调度与写入预算。

| 字段 | 类型 | 默认值 | 边界 |
|---|---|---|---|
| `maxOutputTokens` | 整数 | `5000` | 正安全整数（独立辅助模型输出上限） |
| `extractionMaxWrites` | 整数 | `4` | 1–20（单次提取遍可提交的 `memory_save`/`memory_delete` 数） |
| `maxToolRounds` | 整数 | `8` | 1–24（一遍内的模型请求数） |
| `consolidationMaxWrites` | 整数 | `8` | 1–40（单次合并运行可提交的 `memory_save`/`memory_delete` 数） |
| `consolidationMinChanges` | 整数 | `6` | 1–1000（重新触发一次运行所需的已准入作用域变更数） |
| `consolidationIntervalMs` | 整数 | `86400000` | 60000–2592000000（同一作用域两次运行的最小间隔） |

<a id="extraction"></a>
## 提取

在以 `reason.kind === 'completed'` 观察到的 `turn/end` 上，满足以下任一条件即跳过：

- `extraction` 开关关闭、会话是委派的（`delegationDepthOf(agent) > 0`）、或无法找到会话的 agent；
- 该回合的折叠中没有携带至少三个信号词的人类撰写 `user/message`（空白分隔词元加每个汉字各计一个单位——一个词的回答永不触发复审），或已出现 `memory_save`/`memory_delete` 的 `tool/call`——已经自我整理过的回合无需再审；
- `ctx.memory.scopesFor(agent)` 不提供任何可写作用域，或——`project` 空间下——`authorize('memory')` 在初次准入或后续授权复核时拒绝；
- 没有 `llm` 服务或无法解析 provider/model（每会话警告一次）；
- 会话的耐久提取游标已经到达该 `turn/end` 的 seq——被中断的遍会在下次重审同一片段。

否则，重放前缀加上逐字提取指令（内插当前目录与写入上限）作为一次 `purpose: 'memory'` 请求流式发出；模型驱动下文的受限工具循环。提取游标仅在循环完成后提交，因此被取消或失败的遍会在下次重审同一片段。

待决槽保留最新的、符合提取条件的快照。后续确认回复或已经执行记忆写入的回合不能替换它：其重放前缀、游标目标及触发参与者保持一致。没有符合提取条件的待决快照时，后续完成的回合可以替换该槽，以供合并评估。

<a id="consolidation"></a>
## 合并

每次遍还会对 `scopesFor(agent)` 提供的每个作用域做三重闸门判定——`lastRunAt` 早于 `consolidationIntervalMs`、`changedSince` 达到 `consolidationMinChanges` 次已准入变更（服务在每次条目变更前持久化此保守计数）、以及作用域 `[key, summary, content]` 元组的 sha256 内容摘要与上次运行不同——并对每个合格的作用域运行一次整作用域遍。合并请求是一条独立消息（不重放会话），携带逐字指令与该作用域的完整目录；其写者来源为 `consolidation`。游标——`lastRunAt`、`lastDigest`、`changedSince: 0`——在本轮写入落地后，仅当无其他变更或更新的审查修改所观察的游标时才提交。并发变更会保留后续审查资格；内容不变时不会再次调用模型。

整理插件从资格检查开始，到模型清理和条件游标提交完成为止，持续持有对应作用域。不同 Session 对同一作用域的并发触发会合并到正在运行的审查；不同目录和 SSH 目标的作用域身份保持独立。失败或取消的审查释放作用域，不推进完成进度，后续完成的回合可以重试。每次作用域判定都会重新检查功能开关与触发回合的执行提供方。参见[作用域调度决策](../../../.agents/notes/implemented/bug-fix/2026-10-31-memory-consolidation-coalescing.zh.md)。

合并中的每条工具都限定在所选作用域内，包括未提供筛选条件的搜索。省略作用域时使用当前审查的作用域；显式指定其他或不可用作用域，会在访问存储前返回错误。提取保留本轮开始时提供的作用域，并与代理当前可用作用域取交集。参见[作用域决策](../../../.agents/notes/implemented/bug-fix/2026-10-28-memory-curation-scope.zh.md)。

<a id="the-restricted-tool-loop"></a>
## 受限工具循环

两个遍共享同一个有界循环：流式发出一次请求、执行 `tool-call` 块、把结果回喂、重复，直至模型停止调用工具或 `maxToolRounds` 触发。每次请求都按模型公开的最低推理档位并使用 `maxOutputTokens` 输出上限（默认 5,000）——辅助调用姿态，而非会话调好的设置。只有 `memory_search`、`memory_read`、`memory_save`、`memory_delete` 可执行——对其他工具的调用以错误结果回给模型——每次保存/删除都计入该遍的写入预算。写入经 `ctx.memory.save`/`delete`、以 `{ kind: 'agent', agent, source }` 写者完成，因此服务的校验、作用域准入、project 授权与串行写链全部依旧生效；`execution/forbidden` 拒绝以错误结果呈现给模型而不是抛出 `RemoteError`。取消会中止流，并阻止后续工具、条目及完成游标的准入。本轮将取消信号传入排队中的游标写入；已准入的耐久写入不会被回滚。

每次存储完成、模型调用准备完成、工具结果返回和完成游标准入时，均检查当前开关与已提供作用域。关闭 `enabled` 会取消两种操作；关闭 `extraction` 或 `consolidation` 只取消对应操作。通道等待清理完成后再运行其他操作，保留排队回合，不提交已取消工作的完成进度。所有者读取与已准入耐久写入保持可用。参见[实时操作决策](../../../.agents/notes/implemented/bug-fix/2026-10-31-memory-curation-live-availability.zh.md)。

每个轮次通过 `prepareCall()` 固定适配器与设置，并在发送前记录 `memory/curation-request`，携带遍类型、从零开始的轮次，以及精确且不可变的消息、工具、工具历史和模型设置。请求在 LLM 资源准入中显式保留触发 Session 的执行归属。日志记录失败会阻止发送。这些仅用于日志的事件不进入主对话；提取游标仍指向已审查的完成回合。参见[请求与生命周期决策](../../../.agents/notes/implemented/bug-fix/2026-10-24-memory-auxiliary-ownership.zh.md)。

设置提供者替换与组合配置回退使用[记忆服务可用性通知](../memory/README.zh.md#events)，因此新有效来源关闭操作时，排队工作也会取消。

<a id="cursors-and-attribution"></a>
## 游标与归属

两条耐久游标记录存放在 memory 域的 `cursors` 表（服务仍是唯一写入者）：`extraction-{sessionId}` 保存 `lastSeq`；`consolidation-{scopeId}` 保存 `lastRunAt`、`lastDigest` 与 `changedSince`。每次写入在 `updated` 归属中标记 `source` 为 `extraction` 或 `consolidation`、发起会话 id，以及——project 空间下——由 `executionIdentity` 携带的已授权主操作者 user id。

每个排队遍会捕获触发回合的执行参与者和签发提供方，并在异步准备、模型准入、工具与游标提交期间保留这些参与者。project 整理在每轮请求前、响应后，以及写队列中持久化游标之前重新检查 `authorize('memory')`。其 `llm/pre-dispatch` 监听器还在容量准入后、适配器实际发送请求前复核。签发方被移除或替换会拒绝所捕获的工作；替代方不能出借其操作者或权限。这些检查不会额外预留或计费模型请求。捕获失败只跳过后台整理，不使已完成的主回合失败。参见[授权决策](../../../.agents/notes/implemented/bug-fix/2026-11-01-memory-curation-authority.zh.md)。

插件卸载会取消运行队列，并等待全部活跃遍结束，包括已由 Session 释放触发的清理。每条记忆工具在执行前检查取消，服务在准入条目或排队游标前再次检查。已准入的耐久写入始终由本轮持有，直至结束。

<a id="invariants"></a>
## 不变式

**运行时不变式：** 不发布伴生检查。该遍完全从已提交的会话事件、会话表面投影与耐久的 memory 域状态推导；它不持有可供不变式比较的私有索引。

整理会依据所观察的记录及本轮自身成功写入次数，有条件地提交游标。并发成员编辑、其他审查或空作用域中的新变更会保留较新的计数和审查元数据，让待运行的下一轮能够审查变更后的内容。

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
- 每个会话拥有一个 lane 控制器；会话处置和插件卸载会将其中止。插件处置等待所有活跃任务，包括会话已经从 lane 映射移除的任务。
- 写者 `signal` 搭载在 `MemoryWriter` 上，使 `save`/`delete` 内部的 project 授权观察到与模型流相同的取消。

</details>
