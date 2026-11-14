# Agent Note: Agent Teams 同谱系 merge(rc.3)

Status: implemented

[English](2026-11-25-agent-team-same-lineage-merge.md) | 中文

## Problem

上游 rc.3 将 Agent Teams 提升为 `packages/team/{agent-team,tool-agent-team}`，是一次构建在 version-2 持久事件之上的精简重写：`ProjectionHandle` 驱动的状态、`team/mode` 会话标志取代成员门禁、基于 subagent 目录的受让人解析，以及直接投递 Agent 收件箱的消息机制——把持久 mailbox/roster 事件降为历史记录。fork 的 `packages/experimental/agent-team` 是有意分歧——基于 version-1 事件的持久 roster/mailbox/fold、成员阶段、模型路由、活动等待与写作用域告警——整体替换会删掉 fork 自有语义。本任务是同谱系 merge：移植可转译的上游改进，其余记录处置。

## Decision

两项上游改进可干净移植，已采用：

- **持久化 `ownerName` 归属**。上游在分配时把成员名写入任务快照，而非视图期解析。`TeamTaskSnapshot` 新增可选 `ownerName`；`claim` 写入调用方 membership 名，`reassign` 写入解析出的受让人名，`release`/`reopen`/unassign 经 `withoutOwner` 清除；fold 的 strict `team/task` schema 接受该附加字段；`taskView` 优先取持久名，并为字段引入前的任务回退到在线成员表。归属信息从此可承受未来的 roster 裁剪，并与上游 Remote 可见的快照语义一致。
- **看板变更的调用方取消**。上游把 `AbortSignal` 贯穿 `create`/`update`，使断开的调用方无法提交追加。fork 现在让 `TeamService.createTask`/`updateTask`、`remoteCreateTask`/`remoteUpdateTask` Remote 方法（Typert 将客户端取消绑定到尾部 signal 形参）与 `TaskBoard.create`/`update` 接受 `signal?: AbortSignal`，并在事务内、状态读取前与追加前检查 `signal.throwIfAborted()`。`tool-agent-team` 传入 `exec.signal`，模型驱动的任务调用随工具调用一并取消。

## Consequences

- `TeamTaskSnapshot` 携带附加的可选 `ownerName`；字段引入前的任务仍经成员表做视图解析，无需迁移或版本升级。
- `createTask`/`updateTask`（service 与 Remote）及 `TaskBoard.create`/`update` 接受尾部可选 `AbortSignal`；既有调用方不受影响。
- 上游 v2 team 重写（ProjectionHandle 状态、`team/mode`、descendant-catalog 成员、inbox 消息）在对齐矩阵的 `packages/team/*` 条目下保持 deferred；采用它需要先做出显式的 version-1→2 持久事件迁移决策。

## Alternatives considered

- **整体采用上游 v2 重写** —— 否决：它会以精简的 descendant-catalog/ProjectionHandle 设计替换 fork 的持久 roster（成员阶段、模型路由持久化、`resolveActiveMember`）、mailbox 队列、活动等待、写作用域告警与 version-1 事件 schema。已发布 Session JSONL 的不可变性也使 v1→v2 事件迁移属于显式的 fork 决策，而非 merge。
- **移植基于 `listDescendants` 的 `resolveAssignee`** —— 否决：上游允许任意 continuable 后代作为受让人；fork 的 roster 成员制是更严格且有意为之的模型。
- **移植 `state.enabled`/`team/mode` 守卫** —— 否决：`roster.membership` 已以 `TEAM_NOT_MEMBER` 拒绝非成员；该标志服务于上游的无成员模型。
- **移植 `rootOf(caller)` 队列定根** —— 否决：本地 `journal.transact` 已在 `reserveUse` 准入下按 `root.id` 选择队列；调用方从不持有队列。

## Verification

- `pnpm exec vitest run packages/experimental/{agent-team,tool-agent-team,agent-team-profile,client-ui-agent-team}` —— 117 个测试通过，含两个新用例：claim/reassign 写入并在 release 时清除 durable `ownerName`（对 `foldTeam` 输出断言），以及中止 signal 在追加前拒绝 `createTask`/`updateTask`。
- `pnpm exec tsc -b packages/experimental/agent-team packages/experimental/tool-agent-team` —— 干净；`oxlint` 干净。
