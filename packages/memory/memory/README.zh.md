---
description: "主机侧按作用域持久化的记忆服务：跨会话存活的作用域事实，带串行写入、项目写入授权与有界搜索"
kind: "package-reference"
---
# @deepseek-ai/dsh-memory

[English](README.md) | 中文

主机侧持久记忆服务 `ctx.memory`：作用域解析、校验、串行化的读取-检查-写入变更、项目写入授权，以及对跨会话存活的作用域事实做有界相关性搜索。

## 概述

`dsh-memory` 存储小型持久事实——后续会话仍能看到的记忆条目。每个条目恰好归属一个作用域；组合的 `space` 配置决定存在哪些作用域族。该服务是 Cordis `Service`，以 `memory` 默认导出，`inject = ['storageDomain']`；它拥有 `memory` 存储域（每个条目一个 JSON 文档），在变更前校验所有字段，把全部写入串行到一条 promise 链上，通过执行授权能力对项目写入鉴权，并对搜索结果做有界排序。代理侧消费者——`dsh-memory-context`（目录发布）与 `dsh-tool-memory`（模型工具）——拥有所有面向模型的帧。

## 目录

- [配置](#configuration)
- [作用域与空间](#scopes-and-spaces)
- [写入规则](#write-rules)
- [存储](#storage)
- [搜索](#search)
- [事件](#events)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

| 字段 | 类型 | 默认值 | 边界 |
|---|---|---|---|
| `space` | `'personal' \| 'project'` | `'personal'` | — |
| `entryMaxBytes` | 整数 | `8192` | 256–65536（`content` 的 UTF-8 字节数） |
| `summaryMaxChars` | 整数 | `150` | 20–500（Unicode 码点数） |
| `maxEntriesPerScope` | 整数 | `200` | 1–10000 |
| `searchMaxResults` | 整数 | `10` | 1–50 |

解析后的值以只读形式暴露在 `service.space` 与 `service.limits`。Gateway 项目运行时补丁选择 `space: project`。

<a id="scopes-and-spaces"></a>
## 作用域与空间

`scopesFor(agent)` 同步返回会话可寻址的作用域：

- `personal` 空间 → `{ kind: 'personal' }`，外加会话头携带 `cwd` 时的 `{ kind: 'workspace', directory, sshTarget? }`（`SessionHeader.cwd` / `sshTarget`）；SSH 目标 id 参与工作区键，因此远程目录永远不会与同名主机路径混淆。
- `project` 空间 → 仅 `{ kind: 'project' }`。

`list(scope)` 返回目录行（不含正文的条目），按 kind（`guidance`、`profile`、`background`、`resource`）、`updated.at` 降序、key 升序排列。`read(scope, key)` 返回单个完整条目或 `undefined`。

<a id="write-rules"></a>
## 写入规则

`save(request, writer)` 与 `delete(request, writer)` 把每次读取-检查-写入串行到服务内的一条 promise 链上，并在任何变更前按以下顺序执行：

1. 作用域必须属于该空间——否则 `memory_invalid` / `scope-unavailable`。
2. 代理写入者只能寻址本会话自己的工作区作用域（directory 与 `sshTarget` 均相同）——否则 `memory_invalid` / `workspace-mismatch`；没有 `cwd` 的会话得到 `scope-unavailable`。
3. 字段校验（仅 save）：key `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且至多 64 字符 → `key`；修剪后非空、单行的 summary 至多 `summaryMaxChars` 码点 → `summary`；修剪后非空的 content 至多 `entryMaxBytes` UTF-8 字节 → `content`。存储的 summary 与 content 均为修剪后的值。
4. project 作用域加代理写入者通过 `ctx.get('executionAuthority')` 鉴权：策略拒绝原样传播且不写入任何内容；获证的 `primaryActorUserId` 进入来源记录。
5. 修订语义：不带 `expectedRevision` 的 save 只能创建（`memory_exists`）；带它则只能替换（`memory_not_found`、`memory_stale`）。带 `expectedRevision` 的 delete 必须匹配（`memory_stale`）；键不存在为 `memory_not_found`。
6. 达到作用域上限（`maxEntriesPerScope`）的创建拒绝 `memory_full`；替换与删除永不受限。
7. 写入铸造新的 `randomUUID()` 修订号，更新时保留 `created`，并把 `updated` 记为 `{ source: 'agent', sessionId, userId?, at }`。持久写入在服务返回前完成，`memory/changed` 在提交后发出。

来源记录的 `source` 是封闭联合（`agent`、`extraction`、`consolidation`、`member`）；当前只有 `agent` 写入——其余种类为后续的提取/整合/成员写入者预留了持久模式。

<a id="storage"></a>
## 存储

`memory` 域声明 `layout: 'per-record'` 与 `invalidRecords: 'backup-and-skip'`：每个条目一个 JSON 文档，位于 `<backend-root>/memory/entries/<recordKey>.json`，损坏的记录会被移到一边（`<key>.json.bak.<timestamp>`）而不会阻塞整个域。记录键为 `${scopeId}_${key}`：`_` 作为分隔符，因为作用域 id（`personal`、`project`、`workspace-<sha256(JSON.stringify([sshTarget ?? null, directory])) 前 16 位十六进制>`）和条目键 slug 都不含 `_`，且整体键满足 per-record 单元路径安全的 `[a-zA-Z0-9_-]+` 文法。记录模式是 `MemoryEntry` 的严格 zod 镜像；域在服务构造时打开一次（每次访问都要等待的就绪 promise），在处置时关闭。

该服务要求 `storageDomain`：目前存储族只在 Web 包中挂载，因此 `dsh-memory` 在 `web-app` 包中位于 `storage-domain` 之后挂载；在没有它的组合中，代理侧行保持惰性。

<a id="search"></a>
## 搜索

`search(scopes, query)` 先做 NFKC + 小写归一化，再提取词项（长度 ≥ 2 的拉丁/数字 token；≥ 2 的 CJK 连续段及其二元 bigram），然后按字段为每个条目评分（key ×3、summary ×2、content ×1）：字段包含整个归一化查询时 `+10×weight`，每个被包含词项 `+weight×(1+min(occurrences,5))`。得分为 0 的条目被丢弃；结果按得分降序、`updated.at` 降序、key 升序排列，并以 `searchMaxResults` 封顶。每个命中携带目录行和一段围绕首个匹配词项的空白折叠摘要（至多 160 码点，无匹配时回退 summary），截断边缘以 `…` 标记。修剪后为空的查询返回 `{ ok: false, code: 'memory_invalid', reason: 'query' }`。

<a id="events"></a>
## 事件

`memory/changed(scopeId, key)` 在写入提交后发出；消费者通过服务重新读取，而不是信任负载。

<a id="invariants"></a>
## 不变式

**运行时不变式：** 不发布伴生检查。该服务在一条串行链内经由 `storageDomain` 校验并提交每次写入；持久记录与 `memory/changed` 事件是同一次提交的事实，没有可独立观察、可能偏离的关系。

<a id="model-experience"></a>
## 模型体验

Indirectly, through `dsh-memory-context` and `dsh-tool-memory`, which own every model-facing catalog frame, tool schema, and prompt section this service backs.

#### KV Cache effect

None directly: the service constructs no model input; its consumers' catalog and guidance contributions own any cache behavior.

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **单进程可见性** — 一个运行时中的写入只对该运行时的会话可见；跨运行时传播（浏览器成员、联邦）留给成员/策展 PR。
- **存储族仅在 Web 包中挂载** — `dsh-memory` 依赖 `storageDomain`，而它目前只在 `web-app` 包中挂载；personal 空间的 CLI/headless profile 在其主机组合挂载存储与本服务之前，代理侧行保持惰性。
- **`danger-full-access` 可以编辑存储文件** — JSON 文档以明文存于 Harness home 之下；被授予不受限文件系统访问的会话可以绕过服务的写入规则读取或破坏它们。
- **尚无策展、召回或成员写入者** — 来源联合保留了 `extraction`、`consolidation`、`member` 来源，但当前包代际只存在代理写入。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
