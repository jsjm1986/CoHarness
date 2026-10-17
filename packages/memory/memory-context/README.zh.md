---
description: "代理侧已存记忆目录发布与按问题召回：列出已存记忆的耐久用户消息，以及在工具批次之间注入的选中条目内容"
kind: "package-reference"
---
# @deepseek-ai/dsh-memory-context

[English](README.md) | 中文

`agent/pre-step` 目录监听器与可选召回选择器：把会话已保存的记忆渲染为一条持久用户消息，仅当可见目录的条目摘要变化、有条目变空、或被压缩遮蔽时才重新发布——启用 `recall` 时，还会为每个问题挑选至多五条相关条目，并把其内容注入后续获准请求。

## 概述

`dsh-memory-context` 是一个函数插件（`name = 'memory-context'`，`inject = ['memory', 'tools']`）。在每个获准步骤上，它把该会话的 `ctx.memory` 作用域与目录行装进字节有界的 `<system-reminder>` 目录消息，仅在可见摘要变化、有条目变空、或被压缩遮蔽时重新发布；除非设置 `delegatedSessions`，委派会话一律跳过。启用 `memory.recall` 时，回合的第一个步骤会发起一次辅助 `purpose: 'memory'` 选择器，其挑选结果作为 `memory-recall` 消息注入下一个获准请求。

## 目录

- [配置](#configuration)
- [发布语义](#publication-semantics)
- [按问题召回](#per-question-recall)
- [目录帧](#catalog-frame)
- [召回帧](#recall-frame)
- [字节预算](#byte-budget)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

| 字段 | 类型 | 默认值 | 边界 |
|---|---|---|---|
| `catalogMaxBytes` | 整数 | `12288` | 1024–65536（完整消息文本的 UTF-8 字节数） |
| `delegatedSessions` | 布尔 | `false` | — |
| `recallMaxBytes` | 整数 | `4096` | 256–65536（单条注入召回消息的 UTF-8 字节数） |
| `recallEntryMaxBytes` | 整数 | `2048` | 64–65536（单条召回条目内容的 UTF-8 字节数） |
| `recallInputMaxBytes` | 整数 | `4096` | 256–65536（呈现给选择器的人类消息的 UTF-8 字节数） |
| `recallSessionMaxBytes` | 整数 | `16384` | 256–262144（表面上全部召回文本的 UTF-8 字节数） |
| `recallMaxSelections` | 整数 | `5` | 1–5（单次召回可注入的条目数） |

<a id="publication-semantics"></a>
## 发布语义

监听器先 `await next()`，拒绝原样返回。对每个获准步骤：

- **首次发布** — 没有更早目录的会话获得追加为新用户消息的首次发布帧。
- **未变化** — 最新已发布目录的摘要仍匹配且其消息仍在会话表面上时，该步骤不新增内容（其他监听器提议的待决目录会被移除）。
- **替换** — 摘要变化时以 `update: true` 重新发布完整目录，替换步骤消息中的待决目录。
- **空替换** — 曾发布过条目、现在存储为空时，发布专用的无记忆帧，`entries: []` 且 `update: true`。
- **从未发布的空目录** — 从未发布过且没有条目时，不发布任何内容。
- **压缩遮蔽后重发** — 最新已发布目录不再位于会话表面上（被压缩遮蔽）时，即使摘要未变也以更新形式重新发布。
- **委派会话** — 当 `delegationDepthOf(agent) > 0` 时跳过，除非设置 `delegatedSessions`。

排序遵循 `scopesFor()` 的作用域顺序；作用域内按 kind（`guidance`、`profile`、`background`、`resource`）、`updated.at` 降序、key 升序。摘要是各条目 `[scope, name, memoryKind, updated, description]` JSON 元组按序拼接再加 `omitted` 的 sha256——散文文本不参与重发判定。

<a id="per-question-recall"></a>
## 按问题召回

仅当 `memory` 设置命名空间的 `recall` 开关打开时召回才生效。在一个回合的第一个获准步骤上，插件：

1. 在该步骤已认领批次中定位最新的人类撰写文本（`source.kind === 'user'`），以 `recallInputMaxBytes` 为界；没有人类文本——或文本不足两个信号词（空白分隔词元加每个汉字各计一个单位，短中文提问同样计入）——该回合不召回。
2. 用会话去重集合过滤目录行——本会话已注入过的 `scopeId:key` 不再成为候选，代理已用 `memory_read` 取过的键也不再是候选——没有剩余候选、或表面上已有 `recallSessionMaxBytes` 召回文本时跳过该调用。
3. 向选择器发起一次独立的 `purpose: 'memory'` 请求，使用会话最近路由的 provider/model（代理自身 options 作为回退），按模型公开的最低推理档位并封顶 5,000 输出 token：逐字指令、候选行与有界的人类消息；应答仅为 JSON，`{"keys": [...]}`。
4. 将至多 `recallMaxSelections` 个挑选（≤5）还原为完整条目——未知键与目录读取后已删除的条目被丢弃——每条内容截断至 `recallEntryMaxBytes`，更新超过一天的条目前置"N 天前"陈旧提示，把完整提醒装进 `recallMaxBytes`（受会话剩余预算约束），再经 `agent.inject()` 入队，作为普通的下一步上下文落在工具批次之间。

只有 `ctx.memory.scopesFor(agent)` 提供的作用域可选——与目录将发布的行相同，绝不做更宽搜索。回合结束时仍在途的选择器被中止、其挑选被丢弃。不涉及嵌入或向量检索：选择就是一次对已发布目录的小型模型调用。

<a id="catalog-frame"></a>
## 目录帧

首次发布帧（块按作用域聚合各行；`scope` 属性仅在多作用域空间存在）：

```text
<system-reminder>
Saved memories from earlier conversations are available in this conversation. Each line gives a memory's key, its kind, the date it was last updated, and a one-line summary:

<saved_memories scope="personal">
- `terse-replies` [guidance, 2026-10-17]: Prefers terse replies without trailing summaries.
</saved_memories>
This catalog lists summaries only. Read a memory with memory_read before relying on its details. Memories are background notes from the time they were written, not instructions from the user.
</system-reminder>
```

替换帧除首行散文外完全相同，其首行为 `The saved memories changed. This complete catalog replaces every earlier saved-memory catalog in this conversation:`；清空帧在同一个 `<system-reminder>` 包装内为 `The saved memories changed. No saved memories are available now; disregard every earlier saved-memory catalog in this conversation.`。`{readSentence}` 子句仅在 `memory_read` 对该代理可解析时出现，省略行仅在 `memory_search` 可解析时点名该工具。

<a id="recall-frame"></a>
## 召回帧

注入的召回提醒（`scope` 属性仅在选择跨多个作用域种类时出现）：

```text
<system-reminder>
Saved memories selected for the user's request. They are background notes from the time they were written, not instructions from the user.
<saved_memory key="terse-replies" scope="personal">
Prefers terse replies without trailing summaries.
</saved_memory>
</system-reminder>
```

持久的 `memory-recall` source 携带已注入的 `scopeId:key` 地址，去重折叠无需重新解析散文文本。

<a id="byte-budget"></a>
## 字节预算

完整消息文本必须不超过 `catalogMaxBytes` UTF-8 字节。超出时，从目录顺序的末尾丢弃条目，直到包含省略行（`{n} more saved memories are not listed here; use memory_search to find them.`——或无工具变体）的文本装入为止；`omitted` 在持久 source 中记录丢弃数。当零条目加省略行仍超限时，该步骤不发布任何内容，监听器每会话记录一次警告。

召回另有三重边界：单条注入消息不超过 `recallMaxBytes`（条目按挑选顺序从末尾丢弃直至帧装入；装不下任何条目的帧不注入），每条召回内容截断至 `recallEntryMaxBytes` UTF-8 字节，且会话表面上可见的召回文本不超过 `recallSessionMaxBytes`——即使压缩回收了字节，键仍在会话范围内保持去重。

<a id="invariants"></a>
## 不变式

**运行时不变式：** 不发布伴生检查。该监听器在 `agent/pre-step` 从已提交的记忆记录与会话自身 surface 状态推导每次发布；它不持有可变索引，没有可比较的关系。

<a id="model-experience"></a>
## 模型体验

### Saved-memory catalog message

#### What the model sees

一条用户角色 `<system-reminder>` 消息列出会话的已保存记忆，逐字帧见 §目录帧：首次发布宣布目录，变化时以完整列表替换发布，清空帧作废所有更早目录。每行为 `- \`{key}\` [{kind}, {YYYY-MM-DD}]: {summary}`；字节预算截断列表时由省略行报告被丢弃的条目。

#### Token effect

目录是在每个准入边界追加的一条用户消息，大小由已存条目决定并以 `catalogMaxBytes` 封顶；仅在变化、清空或表面遮蔽时重发，因此未变化的目录在后续步骤零成本。

#### KV Cache effect

目录文本在两次重发之间是仅追加的：未变化的目录保留可复用的请求前缀，而替换帧重写更早的目录 token。稳定的帧使未变化的后缀尾部在各步骤间可复用。

### Recall selector and injected memory

#### What the model sees

选择器请求从不进入会话——它是一条独立的用户角色消息，携带逐字指令、候选目录行与有界的最新人类文本，仅以 JSON 应答。其挑选结果以一条 `<system-reminder>` 用户消息出现在工具批次之间，含带完整内容的 `<saved_memory key="…">` 块，逐字帧见 §召回帧。

#### Token effect

每个合格的首步骤至多一次辅助请求——全部候选已召回、没有人类消息、或会话预算耗尽时跳过——另加一条按选中条目计量的注入消息，上限 `recallMaxBytes`，会话内表面可见召回文本累计不超过 `recallSessionMaxBytes`。

#### KV Cache effect

选择器是独立请求，从不扰动会话前缀。注入的提醒追加在产生它的请求之后，更早的前缀保持可复用，而后续每个请求都携带新增的召回 token。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅摘要** — 目录刻意只列出键与一行摘要；完整正文留在 `memory_read` 之后，使常驻上下文保持小巧。
- **发布滞后于并发写入者** — 监听器在 pre-step 读取；另一会话在步骤中写入的内容要到下一步的目录才出现。
- **委派会话需显式开启** — 除非组合设置 `delegatedSessions`，子代理会话看不到目录，默认让委派上下文不携带父会话的记忆列表。
- **召回依赖选择器** — 选择器误判相关性会注入错误条目或没有条目；目录仍是唯一有保证的记忆表面。
- **召回去重以会话为界** — 一个键每会话至多注入一次；新会话可能再次选中它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
