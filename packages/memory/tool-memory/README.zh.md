---
description: "面向模型的 memory_search/read/save/delete 工具与 tool:memory 已存记忆系统提示词指导段"
kind: "package-reference"
---
# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

四个面向模型的记忆工具——`memory_search`、`memory_read`、`memory_save`、`memory_delete`——外加 `tool:memory` 系统提示词指引节，架于主机 `ctx.memory` 服务之上。

## 概述

`dsh-tool-memory` 是一个函数插件（`name = 'tool-memory'`，`inject = ['memory', 'tools', 'systemPrompt']`）。它注册让模型搜索、读取、创建、替换和删除持久记忆条目的四个工具，以及教授何时保存、何时查询的提示词节。在 `personal` 空间中工具接受 `scope` 参数（`personal` | `workspace`）；在 `project` 空间中每个工具隐式寻址共享项目作用域，写入经过执行授权。`memory_search` 与 `memory_read` 可与同级并行运行；`memory_save` 与 `memory_delete` 独占运行。服务拒绝以带稳定 `code` 的 `HarnessError` 子类抛出，使工具运行时暴露 `{ name, code }`；项目写入授权拒绝以携带面向模型拒绝文本的 `execution/forbidden` 重抛。

## 目录

- [工具](#tools)
- [作用域解析](#scope-resolution)
- [拒绝码](#refusal-codes)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="tools"></a>
## 工具

| 工具 | 种类 | 用途 |
|---|---|---|
| `memory_search` | 读取，可并行 | 对 key/summary/content 的相关性排序命中，各带有界摘要；`scope` 为可选过滤 |
| `memory_read` | 读取，可并行 | 单个完整条目，含变更工具消费的 `revision` 令牌 |
| `memory_save` | 变更，独占 | 无 `revision` 创建（冲突时 `memory_exists`）或带之替换（`memory_stale`）；以 diff 卡片渲染（`memory/{scope}/{key}`） |
| `memory_delete` | 变更，独占 | 删除条目；传入 `revision` 时受其保护 |

<a id="scope-resolution"></a>
## 作用域解析

`scope` 参数仅当 `ctx.memory.space === 'personal'`（双作用域空间）时存在。执行器通过 `ctx.memory.scopesFor(exec.agent)` 解析该参数：`workspace` 映射到会话自己的工作区作用域（无 `cwd` 的会话得到 `memory_invalid`/`scope-unavailable`），`personal` 映射到 personal 作用域，`memory_search` 上省略 scope 时搜索所有可用作用域。无代理的调用抛出 `memory tools require a calling agent`。写入准入本身在服务内——schema 的存在永远不是强制手段。

<a id="refusal-codes"></a>
## 拒绝码

抛出的 `MemoryToolError` 上的稳定 `code`：`memory_exists`、`memory_not_found`、`memory_stale`、`memory_full`、`memory_invalid`（附 `key`、`summary`、`content`、`scope-unavailable`、`workspace-mismatch` 或 `query` 原因）。项目授权拒绝以 `RemoteError` 码 `execution/forbidden` 传播，并携带面向模型的拒绝文本。

<a id="invariants"></a>
## 不变式

**运行时不变式：** 不发布伴生检查。每次工具调用都在工具执行器自身生命周期内委派给 `ctx.memory`；本插件只注册 schema 与提示词指导，不持有可能偏离的关系。

<a id="model-experience"></a>
## 模型体验

### Tool schemas

#### What the model sees

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-memory)中的四个生成式 schema：`memory_search`（query 加可选 scope 过滤）、`memory_read`（scope 与 key）、`memory_save`（scope、key、kind、summary、content、可选 revision）、`memory_delete`（scope、key、可选 revision）。`scope` 参数仅存在于 personal 空间。

##### Tool descriptions

```markdown
memory_search — Search saved memories by words in their key, summary, or content. Returns matching memories ranked by relevance, each with a short excerpt. Read a memory with memory_read before relying on its details.
memory_read — Read one saved memory in full, including the revision that memory_save and memory_delete use to change it.
memory_save — Save a memory that later conversations will see in their saved-memory catalog. Without a revision this creates a new memory and fails if the key is already used. To change an existing memory, read it with memory_read and pass its revision; the content you send replaces the old content entirely.
memory_delete — Delete a saved memory that is wrong or no longer useful. Pass the revision from memory_read when you have one, so that a newer change is not deleted by mistake.
```

#### Token effect

工具可见的每个请求上有四个固定 schema；描述与参数对给定的 `space` 和 `summaryMaxChars` 配置保持稳定。

#### KV Cache effect

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使这些 schema 的复用失效。

### Guidance section

#### What the model sees

`tool:memory` 提示词节（顺序 `TOOL_MEMORY`，2450）教授何时保存、永不保存什么、修订处理以及优先哪个作用域；仅在 `memory_save` 对请求作用域可解析时渲染。

##### Section text (personal space)

```markdown
Saved memories carry knowledge between conversations. The saved-memory catalog in this conversation lists them by key with one-line summaries; memory_search, memory_read, memory_save, and memory_delete manage them.

Save a memory when you learn something that will matter in later conversations and cannot be recovered from the workspace: who the user is and how they like to work (profile); a correction or a confirmed approach to how you should work, with the reason (guidance); goals, constraints, decisions, or deadlines that the code and its history do not show (background); where to find information outside the workspace (resource). When the user asks you to remember something, save it; when they ask you to forget something, delete it.

Do not save what you can read from the workspace — code structure, file paths, conventions, git history, or fixes already in the code — what AGENTS.md files already say, or details that only matter to the current task. Never save secrets, credentials, or tokens.

Before saving, check the catalog or memory_search for a memory that already covers the fact and update it instead of adding a near-duplicate. Delete memories that turn out to be wrong.

A memory records what was true when it was written. Before acting on a memory's claim about files, functions, or flags, check the current workspace, and update or delete the memory if it no longer holds.

Use the personal scope for facts about the user that apply in every workspace, and the workspace scope for facts specific to this conversation's working directory.
```

#### Token effect

工具挂载的每个请求上有一个静态节；文本对给定的 `space` 恒定。

#### KV Cache effect

该节是稳定的常驻前缀；步骤之间不变化，因此它自身永不会使已可复用的前缀失效。

### Tool-call results

#### What the model sees

搜索返回 `<memory_search query="…">` 命中行块（或 `No saved memory matches "{query}".`），读取返回带完整正文的 `<memory key="…" revision="…">` 帧，保存返回 `Created memory "{key}" … (revision {revision}).` 或 `Updated …`，删除返回 `Deleted memory "{key}"{scopeFrom}.`。拒绝以带稳定码与面向模型文本的工具错误到达，例如 `A memory with the key "{key}" already exists in the personal scope. Read it with memory_read and pass its revision to replace it, or choose another key.`

#### Token effect

结果文本每次调用小巧且形状固定；`memory_read` 逐字返回已存正文，受服务 `entryMaxBytes` 写入上限约束。

#### KV Cache effect

仅追加；每个结果跟在可复用请求前缀之后，不会使更早的 KV 缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **`memory_save` 的 diff 卡片使用合成路径** — `memory/{scope}/{key}` 仅为展示路径；把 diff 路径当真实文件处理的客户端应退回 generic 卡片（该字段是元数据，不是文件系统引用）。
- **无批量或列表工具** — 枚举是目录的职责；模型每次只能搜索或读取一个键。
- **scope 参数仅存在于 personal 空间** — project 空间不暴露作用域选择；成员/浏览器写入者与策展在后续 PR 中到来。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
