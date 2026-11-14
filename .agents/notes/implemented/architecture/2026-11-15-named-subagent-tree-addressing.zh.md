# Agent 笔记：具名子智能体树寻址

Status: implemented

[English](2026-11-15-named-subagent-tree-addressing.md) | 中文

## 问题

上游 v0.2.2-rc.3 把以 id 键控的可继续子级替换为具名树：同级持有持久且唯一的名称，成员通过 root `lead` 之下以斜杠连接的路径相互寻址，而 `sendMessage` 可到达共享树中的任何成员，不再限于直接子级或父级。本分支 v0.2.1 时代的通道仅以会话 id 寻址子级——消息由确切相邻关系授权，同级名称不存在，Agent Teams v2 需要的树级投递（同级、更深层后代、跨分支成员、`rootOf`、所有者路径）没有本地对应实现。

## 决定

- 名称是已提交状态而非展示别名：`establishCatalogChild` 与 `establishExternalCatalogChild` 发出携带保留 `name` 的 version-3 记录，与子级记录并列，因此同级命名空间跨重启存续，并可经 `catalogNames` 读取。version 0–2 的解码不变；位于历史未命名环节或之下的成员报告其会话 id，而不是虚构名称。[父级目录决策](2026-09-01-parent-owned-subagent-catalog.zh.md)拥有名称所提交到的目录模型。
- `SiblingNameReservations` 在 `startContinuable` 首个 await 之前同步申领名称，以已提交目录名称为种子：并发创建的同级不可能冲突，`INVALID_AGENT_NAME` 与 `DUPLICATE_AGENT_NAME` 在启动前拒绝，省略时取第一个空闲的 `agent-N`，回滚释放申领而目录提交使其持久化。`lead` 是 root 的名称；子级名称为以字母开头的 1–32 个小写字母、数字或连字符。
- 成员的面向模型名称是从 root 起的同级名称以斜杠连接的路径（`reviewer/checker`），由 `agentAddress`、`joinAgentPath`、`parentAgentPath`、`resolveAgentPath` 构造。会话 id 仍是执行身份：`resolveName` 从在线 root 读取已提交目录，不授予权限，每个特权操作仍检查确切在线 `Agent`/`Session` 身份。
- `sendMessage` 在同一共享 root 内为树级范围：确切在线的树 root 或任何已驻留可继续成员可寻址树内另一成员——同级、更深层后代、直接父级——以 `Agent <sender-name> sent a message:` 投递，并携带持久的 `{ kind: 'agent-message', form: 'relay', senderSessionId }` 归因，记录供稿方但不授予权限。缺席目标在共享 root 之下冷恢复；其自身的创建祖先无需在线。丢失 root 会撤销成员的树访问，root 本身不可冷恢复。
- `rootOf(agent | session)` 返回成员目录谱系所解析到的共享在线 root，`maxActiveSubagents` 是按 root 计数的驻留与物化中可继续 Activation 池，因此一棵树的并发预算与创建关系无关。
- 可继续回执返回持久名称——树相对路径，或在未命名环节之下的会话 id——而结算通知、`list_agents`、`listDescendants` 路径与工具模式按名称寻址成员，会话 id 保留用于路由与转录查找。

## 后果

- Agent Teams v2 获得树级 `sendMessage`、`rootOf`、持久成员名称与所有者路径，且不依赖本通道的内部结构。
- 具名目录记录升至 version 3，version 0–2 历史仍可读；`subagent/descriptor`、计时与生命周期表面不变。
- 任何成员可到达树内其他成员，因此授权完全在服务的确切身份检查中，`resolveName` 的便利永远不授予权限。
- 冷成员的可到达性不再依赖其创建者保持驻留；反之，丢失 root 会使整棵成员树的消息投递失联，尽管各成员自身的会话仍然存续。
- `experimental/tool-subagent-oar` 通道保留工具内名称声明，不发布 version-3 名称；在已提交名称上去重是暂缓事项（[OAR 通道笔记](2026-11-15-subagent-oar-absorption.zh.md)）。

## 考虑过的替代方案

- 否决保持确切相邻消息：Agent Teams v2 需要同级与跨分支投递，而已为冷恢复重建共享谱系的树无需额外状态即可授权任意成员对。
- 否决在读取时派生名称（每次列表投影第一个空闲 `agent-N`）：删除或并发下的重编号会悄悄重定向消息，而已提交名称是恢复后的树唯一能验证的值。
- 否决让名称具有权威性：展示名称可跨树重复且比 Agent 长寿，因此 `resolveName` 刻意返回会话 id，由确切身份检查准入或拒绝。
- 否决将名称申领推迟到目录提交时：两个重叠的启动会各自完成启动工作后才发现冲突；同步的前置申领与上游顺序一致且快速失败。
- 否决按创建者计 `maxActiveSubagents`：一棵树共享一份预算，与谁创建无关；按创建者的池会让一个成员通过子级委派把树扩过上限。

## 验证

- `npx vitest run` 覆盖 subagent 组——1,514 个包测试通过，涵盖 catalog v0–v3 解码、同级名称申领、树级发送与冷恢复、按 root 的池与拆解截止；另有 77 个 agent-team 测试通过。
- 触及包的 `npx tsc` 与 `npx oxlint`——干净。
- `verify-md-links`、`verify-md-wrap`、`verify-translation-pairing`、`verify-export-jsdoc`、`verify-agent-note-format`——对触及文档干净。
