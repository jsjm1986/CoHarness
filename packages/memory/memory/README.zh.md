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
- [成员 Remote 表面](#member-remote)
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
| `extraction` | 布尔 | `false` | `memory` 设置 `extraction`——回合结束的提取遍 |
| `consolidation` | 布尔 | `false` | `memory` 设置 `consolidation`——调度的合并遍 |
| `recall` | 布尔 | `false` | `memory` 设置 `recall`——按问题召回注入 |

解析后的值以只读形式暴露在 `service.space` 与 `service.limits`。Gateway 项目运行时补丁选择 `space: project`。三个开关字段为服务安装的 `memory` 设置节提供初始值（`settingsNamespace('memory')`，项目归属）：设置提供者可实时覆盖，`service.switches()` 在每个判定节点返回当前解析值，消费者不作记忆。

<a id="scopes-and-spaces"></a>
## 作用域与空间

`scopesFor(agent)` 同步返回会话可寻址的作用域：

- `personal` 空间 → `{ kind: 'personal' }`，外加会话头携带 `cwd` 时的 `{ kind: 'workspace', directory, sshTarget? }`（`SessionHeader.cwd` / `sshTarget`）；SSH 目标 id 参与工作区键，因此远程目录永远不会与同名主机路径混淆。
- `project` 空间 → 仅 `{ kind: 'project' }`。

`list(scope)` 返回目录行（不含正文的条目），按 kind（`guidance`、`profile`、`background`、`resource`）、`updated.at` 降序、key 升序排列。`read(scope, key)` 返回单个完整条目或 `undefined`。`entries(scope)` 按同一目录顺序返回完整条目——合并遍的摘要与审查输入。

`getCursor(key)` / `writeCursor(key, cursor)` 读取并提交域 `cursors` 表中的耐久整理游标——`extraction-{sessionId}`（`lastSeq`）与 `consolidation-{scopeId}`（`lastRunAt`、`lastDigest`、`changedSince`），键由导出的 `memoryExtractionCursorKey` / `memoryConsolidationCursorKey` 助手给出。游标写入与条目写入共用同一条串行链。两种游标写入方法均接受可选的操作信号与 `beforeCommit` 授权回调。回调在队列和存储等待结束后授权，并返回在持久化前立即调用的同步检查；拒绝时游标保持不变。回调不得在同一写链上排队记忆写入或游标操作。回调前后均检查取消。每次获准的 save/delete 都在条目修改前持久化其 `changedSince` 标记：游标写入失败会保持条目不变，后续条目写入失败则可能保守地多计变更次数。整理流程在请求审查前比较内容摘要。

`writeCursorIfUnchanged(key, expected, cursor)` 在条目写入队列中比较并提交一个游标。当前记录与 `expected` 不同时返回 `false`，保持存储不变；期望值为 undefined 时要求记录不存在。

<a id="write-rules"></a>
## 写入规则

`save(request, writer)` 与 `delete(request, writer)` 把每次读取-检查-写入串行到服务内的一条 promise 链上，并在任何变更前按以下顺序执行：

1. 作用域必须属于该空间——否则 `memory_invalid` / `scope-unavailable`。
2. 代理写入者只能寻址本会话自己的工作区作用域（directory 与 `sshTarget` 均相同）——否则 `memory_invalid` / `workspace-mismatch`；没有 `cwd` 的会话得到 `scope-unavailable`。
3. 字段校验（仅 save）：key `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且至多 64 字符 → `key`；修剪后非空、单行的 summary 至多 `summaryMaxChars` 码点 → `summary`；修剪后非空的 content 至多 `entryMaxBytes` UTF-8 字节 → `content`。存储的 summary 与 content 均为修剪后的值。
4. project 作用域加代理写入者通过 `ctx.get('executionAuthority')` 鉴权：策略拒绝原样传播且不写入任何内容；获证的 `primaryActorUserId` 进入来源记录。
5. 修订语义：不带 `expectedRevision` 的 save 只能创建（`memory_exists`）；带它则只能替换（`memory_not_found`、`memory_stale`）。带 `expectedRevision` 的 delete 必须匹配（`memory_stale`）；键不存在为 `memory_not_found`。
6. 达到作用域上限（`maxEntriesPerScope`）的创建拒绝 `memory_full`；替换与删除永不受限。
7. 写入铸造新的 `randomUUID()` 修订号，更新时保留 `created`，并把 `updated` 记为 `{ source, sessionId?, userId?, at }`——`source` 对代理写入者为 `writer.source ?? 'agent'`，对浏览器写入为 `member`，`sessionId` 仅代理写入者携带。持久写入在服务返回前完成，`memory/changed` 在提交后发出。

来源记录的 `source` 是封闭联合（`agent`、`extraction`、`consolidation`、`member`）；模型工具默认 `agent`，`dsh-memory-curation` 以 `extraction`/`consolidation` 写入，`member` 记录经下述 Remote 表面产生的浏览器编辑。

合并标记持久化后，每次变更都会重新检查作用域是否仍启用。代理写入在授权前及条目变更前检查操作取消信号。project 写入在标记之后通过原执行授权提供方重新核验权限；执行状态改变、提供方替换、资格撤销或授权流不可用都会拒绝变更，Agent 空闲时也不例外。权限检查不预留模型请求额度，也不为模型请求计费。成员写入保留所捕获的有效期及提供方生命周期。拒绝可以留下保守的变更标记，但条目保持不变。参见[写入生命周期决策](../../../.agents/notes/implemented/bug-fix/2026-10-23-memory-member-authority.zh.md)。

<a id="member-remote"></a>
## 成员 Remote 表面

`MemoryService` 是 `TypertRemoteService`；五个 `@Remote` 方法服务浏览器记忆页面。`memory/scopes` 返回作用域目录——个人 runtime 中是个人作用域加上有条目的工作区作用域，项目 runtime 中仅项目作用域——每个视图附带实时条目数与调用成员的 `writable` 标志，以及 `memory` 段的 `enabled` 标志。`memory/list` 与 `memory/read` 向全体成员提供读取；API proxy 经 `PROJECT_TYPERT_PROCESS_WIDE_READS` 放行这三个读端点。`memory/save` 与 `memory/delete` 使用完整捕获的协作授权经 `memberWriter()` 写入，经 `PROJECT_TYPERT_REGISTRY_AUTHORIZED` 放行：项目作用域写入要求 `mode: 'rw'` 的项目参与者；个人/工作区作用域要求 `personal` 参与者；缺失主体或只读成员身份以共享的 `collaboration-forbidden` 拒绝。排队写入在持久化前及条目修改前检查主体有效期和提供方生命周期；授权过期或失效时拒绝修改条目。没有[协作要求](../../context/collaboration/README.zh.md#application-authorization)的独立应用保持所有者语义。

服务注册 `memory` 设置命名空间（`installSettingsSection`，owner `project`，`projectWrite: 'manager'`），含 `enabled` 字段（默认 `true`）与 `extraction`、`consolidation`、`recall` 三个开关（默认 `false`）。`enabled` 置为 `false` 会使 `scopesFor` 返回空——agent 看不到目录且一切写入拒绝 `scope-unavailable`——成员读取与已存条目仍可查看。

<a id="storage"></a>
## 存储

`memory` 域声明 `layout: 'per-record'` 与 `invalidRecords: 'backup-and-skip'`：每个条目一个 JSON 文档，位于 `<backend-root>/memory/entries/<recordKey>.json`，每条整理游标一个文档位于 `memory/cursors/`，损坏的记录会被移到一边（`<key>.json.bak.<timestamp>`）而不会阻塞整个域。记录键为 `${scopeId}_${key}`：`_` 作为分隔符，因为作用域 id（`personal`、`project`、`workspace-<sha256(JSON.stringify([sshTarget ?? null, directory])) 前 16 位十六进制>`）和条目键 slug 都不含 `_`，且整体键满足 per-record 单元路径安全的 `[a-zA-Z0-9_-]+` 文法。记录模式是 `MemoryEntry` 的严格 zod 镜像；域在服务构造时打开一次（每次访问都要等待的就绪 promise），在处置时关闭。提供方卸载会等待待决打开完成，并关闭迟到的域，使替换方能够重新打开；参见[生命周期决策](../../../.agents/notes/implemented/bug-fix/2026-10-24-memory-domain-open-disposal.zh.md)。

该服务要求 `storageDomain`：目前存储族只在 Web 包中挂载，因此 `dsh-memory` 在 `web-app` 包中位于 `storage-domain` 之后挂载；在没有它的组合中，代理侧行保持惰性。

<a id="search"></a>
## 搜索

`search(scopes, query)` 先做 NFKC + 小写归一化，再提取词项（长度 ≥ 2 的拉丁/数字 token；≥ 2 的 CJK 连续段及其二元 bigram），然后按字段为每个条目评分（key ×3、summary ×2、content ×1）：字段包含整个归一化查询时 `+10×weight`，每个被包含词项 `+weight×(1+min(occurrences,5))`。得分为 0 的条目被丢弃；结果按得分降序、`updated.at` 降序、key 升序排列，并以 `searchMaxResults` 封顶。每个命中携带目录行和一段围绕首个匹配词项的空白折叠摘要（至多 160 码点，无匹配时回退 summary），截断边缘以 `…` 标记。修剪后为空的查询返回 `{ ok: false, code: 'memory_invalid', reason: 'query' }`。

摘要通过兼容分解和字素簇边界，将规范化匹配位置对应回原文。兼容字符、组合序列及小写展开均保留原文与匹配上下文；参见[原文位置决策](../../../.agents/notes/implemented/bug-fix/2026-10-28-memory-search-source-offsets.zh.md)。

<a id="events"></a>
## 事件

`memory/changed(scopeId, key)` 在写入提交后发出；消费者通过服务重新读取，而不是信任负载。同步观察者异常会被记录，不会让已经提交的修改变成失败结果。

`memory/switches-updated` 要求消费者在记忆设置提交，或设置提供者挂载、替换、移除后，重新读取自己注入的服务。通知不携带快照，接线时可能重复。同步订阅者立即取消不可用的工作，异步清理由现有所有者等待。观察者失败不阻止后续订阅者收到通知。提供者丢失时仍使用文档规定的组合配置回退。参见[有效来源决策](../../../.agents/notes/implemented/bug-fix/2026-11-01-memory-provider-availability.zh.md)。

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

- **单 runtime 可见性** — 一个 runtime 中的写入只对该 runtime 的会话与 Remote 成员可见；跨 runtime 传播（联邦）延后。
- **存储族仅在 Web 包中挂载** — `dsh-memory` 依赖 `storageDomain`，而它目前只在 `web-app` 包中挂载；personal 空间的 CLI/headless profile 在其主机组合挂载存储与本服务之前，代理侧行保持惰性。
- **`danger-full-access` 可以编辑存储文件** — JSON 文档以明文存于 Harness home 之下；被授予不受限文件系统访问的会话可以绕过服务的写入规则读取或破坏它们。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
