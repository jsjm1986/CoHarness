# Agent Note: Space-scoped agent memory for personal and project spaces

Status: proposed

[English](2026-10-17-space-scoped-agent-memory.md) | 中文

## Problem

每个会话都从空的上下文窗口开始。agent 在工作中学到的持久知识——用户的纠正与偏好、代码里看不出的项目约束、外部资料在哪里——在会话结束时消失，下一个会话又问同样的问题、犯同样的错误。在共享的项目空间里损失成倍放大：一个成员的 agent 学到的团队约定，其他成员的 agent 全都不知道。

harness 有相邻的机制，却没有跨会话记忆。[`agent-instructions`](../../../../packages/context/agent-instructions/README.zh.md) 加载人写的 `AGENTS.md`。[`session-reference`](../../../../packages/context/session-reference/README.zh.md) 注入用户引用的会话。`tool-session-query` 让模型搜索同一目录下的更早会话。[可召回 compaction](2026-07-06-recallable-compaction.zh.md) 在一个会话内恢复被遮蔽的历史。它们都没有给 agent 一个记录持久事实的地方，也不会在同一空间后续的每个会话里提供这些事实的有界目录。

runtime 约束了这种存储放在哪里、谁能写：

- `workspace-write` 下，文件修改与 bash 沙箱只能写会话的原始目录和临时区（[`writableRoots`](../../../../packages/sandbox/sandbox/src/roots.ts)）；会话的执行世界还可能是 SSH 目标而不是本机。
- Gateway 项目 runtime 在项目目录内运行，它的 Harness home 位于项目目录之外；每个个人 runtime 有自己的 Harness home（[启动上下文](../../../../gateway/src/instances.ts)）。
- 一个项目 runtime 进程服务所有成员的会话。资源能力由 `ExecutionAuthority.authorize(capability)` 与 Gateway 的参与者资格检查（[`eligibleActors`](../../../../gateway/src/execution-identity.ts)）按每个执行参与者判定。
- 项目对话除私有对话外对所有成员可见，只有 Gateway 知道一个对话的可见性。
- API proxy 只放行其显式端点表中列出的项目范围 Remote 端点（[`authorizeTypertRemote`](../../../../packages/host/apiproxy/src/api-proxy.ts)）。
- 在 Web 产品中，进程级服务与 Remote 接收方是 host 平面行，模型工具与每会话上下文是从 [agent preset](../../implemented/architecture/2026-08-03-per-session-agent-presets.zh.md) 挂载的 agent 平面行（[平面拆分](../../../../packages/bundle/web-app/cordis.patch.yml)）。

## Proposal

把 agent 记忆做成由一个 host 服务 `dsh-memory`（`ctx.memory`）拥有的能力：它把记忆条目保存在每个 runtime Harness home 内的 `memory` 存储域里，并在自身的写入操作中执行全部写入规则。从 agent preset 挂载的 agent 平面消费方把记忆目录发布进会话（`dsh-memory-context`）、给模型提供记忆工具（`dsh-tool-memory`）、并可选地在回合后整理记忆（`dsh-memory-curation`）。浏览器插件（`dsh-client-ui-memory`）让人浏览和编辑记忆。Gateway 新增 `memory` 资格车道，管控 agent 对共享项目记忆的写入。

组件集合对应 ZCode 的记忆子系统，其源码已端到端读过（见下文 prior-art 一节的映射）；每个组件都绑定到 harness 已有的机制，并使用本仓库的命名。

## Spaces and scopes

`memory` 行的 `space` 设置决定 runtime 提供哪些作用域。个人 runtime 与独立产品使用默认值 `personal`；Gateway 的项目 runtime patch 设为 `project`。

| 空间 | 作用域 | 读者 | agent 写入 | 成员在浏览器中编辑 |
|---|---|---|---|---|
| 个人 | `personal`——适用于所有工作区的用户事实 | 本人 | 允许 | 本人 |
| 个人 | `workspace`——某个工作目录特有的事实 | 本人 | 允许，仅限该工作区的会话 | 本人 |
| 项目 | `project`——项目团队共享的事实 | 全体成员 | 需要 `memory` 能力 | 读写成员 |

工作区作用域由会话的执行目标及其规范化原始目录共同标识，因此 SSH 会话的目录不会与同路径的本机目录混为一谈。个人记忆从不进入项目空间的会话：项目对话可被其他成员读取，在那里注入成员的个人记忆会造成泄露。

## Entries

一个条目是一条事实：带品牌的 `key`（小写字母、数字和单个连字符，至多 64 个字符，作用域内唯一）、`kind`、用于目录和召回的一行 `summary`（至多 150 个字符）、不超过配置字节上限的 Markdown `content`、每次写入都会变化的不透明品牌 `revision`，以及记录写入来源（`agent`、`extraction`、`consolidation` 或 `member`）、会话 id、runtime 已知时的公开用户 id 和时间的 `created`/`updated` 字段。

kind 闭集为 `profile`（用户或团队是谁：角色、专长、偏好）、`guidance`（agent 应如何工作：纠正与已确认的做法，并附原因）、`background`（代码和历史都看不出的目标、约束、决定与截止日期，使用绝对日期）、`resource`（工作区之外的信息在哪里）。服务在写入前校验每个字段与每作用域的条目上限。条目之间不带链接语法。

## Storage

`dsh-memory` 通过 `ctx.storageDomain`（[域存储决定](../architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)）打开一个 `memory` 域，使用 per-record 布局与 `backup-and-skip` 无效记录策略，沿用 [schedule 域](../../../../packages/schedule/schedule/src/storage.ts) 的做法。Web bundle 已挂载存储家族且其根在 Harness home 中，因此个人 runtime 把记忆存在其属主的 Harness home，项目 runtime 存在项目 runtime 的 Harness home——位于项目目录之外，也位于所有沙箱可写根之外。服务串行化读-检查-写序列，每次写入在 resolve 之前持久化，并且只在提交之后发出 `memory/changed`。

## Catalog injection

`dsh-memory-context` 是一个 agent 平面行，其 `agent/pre-step` 监听器以 skill 目录为蓝本（[tool-skill](../../../../packages/skill/tool-skill/src/index.ts)、[目录刷新决定](../../implemented/feature/2026-07-27-skill-catalog-hot-refresh.zh.md)）。下游监听器决定本步之后，它推导会话各作用域的条目，并把其模型可见字段的摘要与会话 surface 上最近可见的目录比较。两者不同时，它录入一条 `user/message`，其 source 为 `{ kind: 'memory-catalog', form: 'catalog', update?: true, entries, omitted? }`：首次发布列出目录，之后的发布替换所有更早的列表。持久的 `entries` 让对话视图无需解析面向模型的文字即可渲染目录；与 surface 的比较让 compaction 遮蔽旧目录后重新发布。

目录按作用域分组，按 kind（guidance、profile、background、resource）、再按最近更新时间、再按 key 排序。配置的字节预算作用于完整消息文本；放不下的条目计入 `omitted`，并以一行文字引导模型使用 `memory_search`。目录文本只含摘要，表述为写入当时的背景笔记而非指令。委派会话不接收目录，除非该行的 `delegatedSessions` 设置开启。

## Model tools

`dsh-tool-memory` 注册四个工具，其操作调用 `ctx.memory`：

- `memory_search` 在 key、摘要和正文中匹配词语（含 CJK 二元组），返回排序后的条目和摘录。
- `memory_read` 返回一个条目的完整内容及其 revision。
- `memory_save` 不带 revision 时创建条目，key 已存在则失败；带 revision 时只有该 revision 仍为当前值才替换条目。
- `memory_delete` 删除条目，并校验给出的 revision。

只有当空间提供多个作用域时才出现 `scope` 参数。一个静态系统提示段说明该保存什么、绝不保存什么（可从工作区推导的事实、`AGENTS.md` 内容、任务局部细节、秘密）、如何选择作用域和 kind、要更新而非重复，以及在依据记忆行动之前核实其中关于代码的说法。`memory_save` 声明 `diff` 渲染意图，使修改以新旧内容的形式呈现。

## Write authorization

`ctx.memory.save()` 与 `ctx.memory.delete()` 在修改之前执行全部规则，因为模型工具、整理和浏览器都只经由这两个操作写入记忆：

- **个人与工作区作用域。** agent 写入方只能指向自己会话的工作区。除已授权的执行外不需要额外授权。
- **项目作用域，agent 写入方。** 服务调用 `executionAuthorityOf(ctx)?.authorize('memory', agent, signal)`。Gateway 要求每个参与者持有用户级 `memory` 资格、项目开启该资格、每个非管理员参与者是读写成员（既有的写入者规则），且对话对项目可见；私有对话可以读取项目记忆，但不能写入。
- **项目作用域，成员写入方。** 浏览器编辑要求捕获到的协作参与者具有读写权限。API proxy 通过一张由所属服务自行授权参与者的表放行记忆写入端点，并把读取端点作为进程级读取放行。

记忆文件位于所有沙箱可写根之外，因此在 `read-only` 与 `workspace-write` 下服务是它们唯一的写入者。`danger-full-access` 对所有文件修改都不设限；在托管项目 runtime 中它本就需要插件管理授权。

## Background curation

`dsh-memory-curation` 是一个带两个可选 pass 的 agent 平面行。两者都在触发回合捕获的执行身份下运行，在第一次模型调用之前完成授权，携带该身份发送 `purpose: 'memory'` 以把用量归到发起成员，并且只通过 `ctx.memory` 以各自的写入来源写入。

- **提取（extraction）** 在回合以 `completed` 原因结束后运行。已调用 `memory_save` 或 `memory_delete` 的回合、没有人类正文的回合以及委派会话都跳过。请求按会话合并（一个运行、一个挂起），记忆域中持久的每会话游标限定转录切片。请求重放会话上一次请求的前缀——system 头、surface 消息和请求头中的工具，与 compaction 在 [`buildSummarizationInput`](../../../../packages/compaction/compaction-basic/src/region.ts) 中复用 provider 前缀缓存的做法相同——并追加列出当前目录的提取指令。随后一个有界工具循环只执行记忆操作，其他工具调用一律作为错误结果返回。
- **整理（consolidation）** 在一次回合结束 pass 后运行，前提是该作用域的闸门合格：`lastRunAt` 早于配置的间隔，`changedSince` 已提交变更数达到配置阈值（服务在其串行写链内递增该计数），且作用域 `[key, summary, content]` 元组的 sha256 内容摘要与上次运行不同。它审视整个作用域，合并近似重复、删除被推翻或过期的条目、转换相对日期，并使用更大的轮次上限。`consolidation-{scopeId}` 游标——`lastRunAt`、`lastDigest`、`changedSince: 0`——仅在该运行的写入落地后提交，因此对未变化内容的重复运行不发起模型调用，被中断的运行会自行重新武装。

`memory` 设置命名空间在插件页提供一个 `enabled` 总开关，以及 `extraction`、`consolidation` 与 `recall` 三个整理开关；整理开关默认全部关闭。关闭时，记忆只会因 agent 主动保存或有人编辑而改变。

## Per-question recall

`recall` 开关开启时，`dsh-memory-context` 在回合第一步发起一次辅助选择请求。该请求接收目录字段与最近一条人类消息——以 `recallInputMaxBytes` 为界——返回至多 `recallMaxSelections` 个 key（五条封顶），为 JSON `{"keys": [...]}`。监听器把选中条目的正文（各自截断至 `recallEntryMaxBytes`，并按每条消息 `recallMaxBytes` 装入）作为 `memory-recall` 上下文通过 `agent.inject()` 注入，使其加入下一次被接纳的请求；回合结束时仍挂起的注入会被丢弃。从 surface 折叠得到的每会话字节预算（`recallSessionMaxBytes`）与从持久 `memory-recall` 事件折叠的 `scopeId:key` 地址集合限制重复——即使 compaction 回收了字节，一个键在同一会话内也不会被再次选中。整个过程不涉及 embedding 服务。

## Earlier-session lookup

ZCode 的 `ReadSessionContext` 对应已有的 `tool-session-query` 工具。它们按工作目录相等授权目标会话，这在项目 runtime 中会暴露其他成员的私有对话，因此要在项目空间启用，除目录检查外还必须让每个目标都经过 `CollaborationAuthority.readableSessionIds()` 过滤。

## Browser surface

`dsh-client-ui-memory` 在侧边栏增加记忆页面。个人空间中它显示个人作用域和每个有条目的工作区作用域；项目空间中显示项目作用域。页面按 kind 分组条目、支持搜索，并展示每个条目的内容、修订时间、写入者记录和指向来源对话的链接。当服务报告该作用域对调用者可写时，可以创建、编辑和删除条目。插件页上的一张卡片编辑 `memory` 设置命名空间。

## Package map

| 包 | 平面 | 职责 |
|---|---|---|
| `packages/memory/memory`（`@deepseek-ai/dsh-memory`） | Host | `ctx.memory`：空间与作用域、条目校验、`memory` 存储域、写入授权、`memory/*` Remote 方法与 `memory/changed`、`memory` 设置命名空间 |
| `packages/memory/memory-context`（`@deepseek-ai/dsh-memory-context`） | Agent | 目录发布与按问召回 |
| `packages/memory/tool-memory`（`@deepseek-ai/dsh-tool-memory`） | Agent | `memory_search`、`memory_read`、`memory_save`、`memory_delete` 及记忆指导段 |
| `packages/memory/memory-curation`（`@deepseek-ai/dsh-memory-curation`） | Agent | 提取与整理 pass |
| `packages/client/ui-memory`（`@deepseek-ai/dsh-client-ui-memory`） | 浏览器 | 记忆页面与设置卡片 |
| `gateway/` | Gateway | `memory` 资格车道与项目 runtime 的 `space: project` 设置 |

standard、PTC 与 Cordis preset 挂载 agent 平面行；minimal preset 不挂载。Web bundle 在存储家族之后挂载 host 行。

## Prior art — ZCode, verified against source

| ZCode 组件 | 本设计 |
|---|---|
| CLI 存储根下按工作区的记忆目录 | 每个 runtime Harness home 中按空间划分作用域的 `memory` 存储域 |
| 一事实一 Markdown 文件，`user` / `feedback` / `project` / `reference` 类型与 `[[name]]` 链接 | 每个 key 一条经校验的条目，`profile` / `guidance` / `background` / `resource` kind，无链接语法 |
| agent 维护、每会话加载一次的 `MEMORY.md` 索引 | 由服务推导、变化时重新发布的目录 |
| 记忆路径上的 Write 与 Edit，由权限规则自动放行 | 专用记忆工具；共享项目写入需要 `memory` 能力 |
| 写入 frontmatter 的 `originSessionId` | 每个条目的创建与更新字段 |
| 每个成功回合后的后台提取 agent | 提取 pass，默认关闭 |
| 已实现但未接线的 dream 整理 pass | 整理 pass，默认关闭 |
| 经辅助选择器的语义召回，在交付代码中关闭 | 按问召回，默认关闭 |
| `ReadSessionContext` | `tool-session-query`，带项目空间 ACL 过滤 |
| 按 agent profile 的子 agent 记忆 | 推迟到有 agent preset 需要独立记忆时 |

## Delivery stages

1. `memory` 资格车道：执行能力、Gateway 资格判定、迁移，以及管理员 API 与界面。
2. 基础：`dsh-memory`、目录发布、模型工具、preset 与 bundle 行、项目 runtime 设置、API proxy 表、文档与快照覆盖。
3. 记忆页面与设置卡片。
4. 提取、整理与 `memory` 模型调用用途。
5. 按问召回。
6. 项目空间中 `tool-session-query` 的协作感知过滤。

## Alternatives considered

**记忆文件放在仓库内，用普通文件工具写入。** 仓库是沙箱可写根，bash 或文件工具可以不经车道就写入项目记忆。这些文件还会出现在每个成员的工作树里，SSH 会话会在远端机器上另存一份。拒绝。

**记忆文件放在 Harness home，用普通文件工具写入。** 会话的文件工具作用于其执行世界，可能是沙箱或 SSH 目标，而 Harness home 位于可写根之外。拒绝，改用其操作在 host 服务中运行的工具。

**由 agent 维护的索引文件。** 每次保存都需要两次协调写入，索引还会与条目脱节。从条目推导的目录不会脱节。拒绝。

**把个人记忆注入项目空间会话。** 项目对话可被其他成员读取。拒绝。

**记忆块或提取加向量服务（Letta、mem0、Zep）。** 它们引入会话日志和人都无法审计的存储与检索路径。这里的召回使用基于目录的辅助选择器，不需要 embedding。拒绝。

**单次结构化输出的提取调用。** 替换条目需要其当前内容与 revision，单次调用无法先读取。基于记忆操作的有界循环可以。拒绝。

**agent 写入只用项目级授权。** 管理员将无法单独收回某个成员的 agent 写入共享记忆的能力，车道也会与桌面、终端、SSH 车道不一致。拒绝。

**默认开启提取。** 它给每个符合条件的回合增加一次模型调用，计费到发起成员。拒绝；开关在插件页。

**现在就做按 preset 的记忆。** 目前没有 agent preset 需要独立记忆。推迟：当有需要时，条目增加 preset 维度，目录按其过滤。

## Acceptance criteria

- **车道。** 只有当每个参与者持有用户级记忆资格、项目开启该资格、每个非管理员参与者是读写成员、且对话对项目可见时，`authorize('memory')` 才成功。在个人 runtime 与私有对话中被拒绝。撤销授权会使运行中会话的下一次检查失败。管理员在 Gateway 界面管理两级授权。
- **基础。** 空间中有条目的会话记录一条 `memory-catalog` 消息，其 entries 在字节预算内等于作用域条目，日志可重建注入的确切文本。另一会话中的修改在下一步发布替换目录，compaction 之后目录重新发布。工具写入执行 key、kind、摘要、正文、revision 与条目数规则。无授权参与者的项目写入在 `ctx.memory.save()` 内被拒绝（经工具执行器证明），读取不受影响。只读成员的浏览器写入被拒绝。经 Loader 启动的仅测试组合证明存储往返与 dispose。模型可见文本由包 README 引文与无密钥快照钉定。
- **浏览器。** 记忆页面在两种空间中列出、搜索、打开、创建、编辑和删除条目，并为只读成员显示只读状态；设置卡片写入 `memory` 命名空间。
- **整理。** 开启提取时，真实 provider 的端到端测试在一个会话中记录一条事实，同一空间的后续会话在目录中收到它。开关关闭时不发起整理模型调用。授权被拒时不发起模型调用。整理把预置的一对重复条目合并为一条。
- **召回。** 开启召回时，匹配的问题在下一次被接纳的请求中注入选中正文，且不超过每条与每会话预算。关闭时不发起选择请求。
- **会话检索。** 在项目 runtime 中，`tool-session-query` 从不返回其他成员的私有对话。

## Risks

- **目录成本。** 每次重新发布都会把目录加入对话。字节预算、单行摘要和仅在变化时发布限制了成本；语料较大时依靠 `memory_search` 与召回而非目录。
- **记忆质量。** agent 可能保存低价值或错误的事实，提取会放大这一点。整理默认关闭，指导排除可推导事实，整理 pass 合并与修剪，人也可以编辑或删除任何条目。
- **持久化的不可信文本。** 在一个对话中写入的内容会进入之后的对话。目录与召回把记忆表述为带日期的背景而非指令，条目的写入者字段标明每个写入者，项目写入需要车道授权。
- **秘密。** 模型可能违背指导保存凭据。成员可以删除；服务不检查内容中的秘密。
- **单进程可见性。** 域状态以内存为准，因此共享同一 Harness home 的两个独立进程在重启前看不到彼此的写入。Gateway runtime 每个空间运行一个进程。
- **不设限的会话。** `danger-full-access` 可以直接修改存储文件，绕过服务的检查。
