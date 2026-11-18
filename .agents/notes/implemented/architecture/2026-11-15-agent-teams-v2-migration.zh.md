# Agent Note：experimental 包路径上的 Agent Teams v2 迁移

状态：已实现

[English](2026-11-15-agent-teams-v2-migration.md) | 中文

## 问题

分叉里的 experimental Agent Teams 包仍是本地 v1 设计——带 `team/member` 供给记录的持久名单、`team/message/queued` 与 `delivered` 的 Team 本地邮箱、六个面向模型的协作工具（`spawn_teammate`、`list_agents`、`send_message`、`wait_agent`、`followup_task`、`interrupt_agent`），且没有显式模式。上游 `dsh-v0.2.2-rc.3` 把 Agent Teams 迁到 v2 语义：teammate 就是普通的有名可续 subagent，消息走 subagent 收件箱，模型面只剩四个任务工具，并由根选择的 `team/mode` 事件总控整个特性。已发布的本地 v1 日志必须保持可读且不能被改写。

## 决策

- 保留 experimental 包路径与 npm 名（`experimental/agent-team`、`tool-agent-team`、`client-ui-agent-team`、`agent-team-profile`）；不携带上游 `team/*` 与 `client/ui-agent-team` 的搬迁。
- 事件声明合并为版本联合：`team/member`、`team/task`、`team/message/queued`、`team/message/delivered` 接受 `{version: 1 | 2, ...}` 仅用于解码，另加新的 `team/mode: { enabled: boolean }`。写入方只发出 `version: 2` 的任务记录与 `team/mode`。
- `agentTeam` 是 `sessionProjections` 注册（`teamProjectionDefinition`），宿主状态为 `{id, enabled?, tasks, nextTaskNumber, inheritedEventCount}`，连线视图携带 `{enabled, tasks: TeamTaskView[], failure?}`。历史 v1 任务记录正常折叠并隐含启用模式，使已发布日志保持可操作；member 与 message 记录被信封联合容忍、其余忽略。
- `TeamService` 保留本地 `TypertRemoteService` + `ctx.agents.reserveUse` 日志纪律：变更经 `TeamJournal.transact` 在根 Session 上串行化，追加 v2 记录、flush，并在持久化未确认时抛出 `TEAM_TASK_PERSISTENCE_UNCONFIRMED`。`setEnabled` 仅根可用（`TEAM_LEAD_REQUIRED`），每次变更写一条 `team/mode`；`defaultEnabled` 在 `agent/created` 时为新根选择模式。
- 任务指派与展示名通过 `ctx.subagents`（`rootOf`、`namesOf`、`resolveName`、`listDescendants`）解析，不再使用本地名单；`ownerName` 与 Session id 相同则省略。
- `tool-agent-team` 只在 `when: enabled(agent)` 之后注册 `team_task_create`、`team_task_list`、`team_task_get`、`team_task_update` 四个工具并附 `TEAM_POLICY` 提示段；六个退役的 Team 工具不再重建——subagent 创建与消息属于 `packages/subagent` 工具。
- experimental UI 保留其 header-action 组合，但改读 `useProjection('agentTeam')` 与 subagent 目录，不再使用已移除的 `TeamView` 远程视图；模式选择调用 `agentTeams/setEnabled`，并在面板内提供两段式停用确认。
- profile 补丁只插入三个 team 插件，无 config、无 disable；废弃键（`maxMembers`、`maxPendingMessagesPerMember`、`maxMessageBytes`、`disposalTimeoutMs`、`freshProvider`、`forkProvider`）在加载时报错或从组合中移除。
- `agentTeams/setEnabled` 在 `remote-session-routing` 中路由为写操作，并在 liveshare 端点表中归类为 `owner-only`。

## 影响

- 已发布的 v1 Session 日志可解码、可折叠（任务记录隐含启用）；不改写任何已提交的代。
- Team 模式持久化、由根选择、在树内共享：`rootOf` 推出 Lead Session，任务板写在其日志中，后代读取根的所选模式。
- 模型面与上游完全一致；通用 subagent 控制工具负责生命周期与消息，特性以组合而非复制的方式工作。
- 在兼容处保留本地强项：持久日志确认、Session 移除预留、CAS 修订、写范围告警、具名/树相对寻址、头部面板 UI，以及无密钥确定性 fixture 与快照通道。

## 已考虑的替代方案

- 保留 v1 roster/mailbox/fold 模块与 v2 并存被否决：两套任务/成员权威会分叉，退役工具也会与已发布的 subagent 工具重复。模块已删除；v1 仅以可解码的事件联合与隐含启用语义存活。
- 保留旧的 `agentTeams/view` 远程投影被否决，因为 `useProjection('agentTeam')` 已通过标准投影通道提供相同的连线数据。
- 在 `team/task` 记录上增加本地模式字段被否决；上游独立的 `team/mode` 事件让模式变更换保持仅追加，不触碰任务修订 CAS。

## 验证

- `pnpm vitest run packages/experimental/agent-team/tests`——投影 v1/v2 解码、模式折叠、不支持版本的失败、修订连续性、tombstone 过滤；服务模式门控、CAS、根作用域、v1 读取兼容、配置拒绝；v2 持久写入确认。
- `pnpm vitest run packages/experimental/tool-agent-team/tests`——按模式准入、恰好四个注册任务工具、退役工具缺席、端到端 create/list/get/update。
- `pnpm vitest run packages/experimental/client-ui-agent-team`——远程挂载/卸载、`setEnabled` 接线、目录导航、面板名单/任务板/模式开关渲染。
- `pnpm vitest run packages/experimental/agent-team-profile` 与 `packages/host/apiproxy/tests/session-purge-composition.spec.ts`——最小补丁形态与清除预留/错误路径行为。
- 确定性 fixture 通道：`examples/headless-agent` team 场景通过无密钥适配器驱动 v2 面（`subagent` + `send_message` + `team_task_*`）。
