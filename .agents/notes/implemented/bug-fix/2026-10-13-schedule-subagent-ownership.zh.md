# Agent Note: Schedule 子 agent 归属——目标拒绝与委派调用方拒绝

Status: implemented

[English](2026-10-13-schedule-subagent-ownership.md) | 中文

## Problem

被委派子 agent 的 Session 永远收不到投递的提醒：投递通过共享 Session controller 解析绑定的 Session，而它会拒绝委派子 agent 的活跃 Agent。在修复之前，`ScheduleService.create` 与 `ScheduleService.update` 仍然会为这类 Session 装配任务，使记录永久过期并在每次 drive 上重试，且四个 schedule 工具允许委派调用方直接管理提醒。上游提交 `96c421d9857`、`500295b2bdf`、`699f1a8dc18` 与 `1b1b09e1fbe` 封堵了两个方向；本地架构需要用不同的层表达同一条规则。

## Decision

- 当目标 Session 的活跃 Agent 读得 `delegationDepthOf(agent) > 0`——即委派封顶本身执行的记账、由持久化 session header 承载并跨冷恢复保留——`ScheduleService.create` 抛出 `ScheduleInputError('subagent_session')`，`ScheduleService.update` 返回非变更的 `{ code: 'subagent_session' }` 结果。`list`、`catalog`、`history` 与 `delete` 保持开放，已存任务仍可查看与移除。
- 四个 schedule 工具（`schedule_create`、`schedule_list`、`schedule_delete`、`schedule_update`）在分发前检查 `delegationDepthOf(exec.agent)`，并返回稳定的 `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }` 值；`subagent_session` 加入 `ScheduleInputError` 的 code 联合、`SubagentSessionError`/`ScheduleToolError` 公共联合、update 结果联合与工具输出 schema。
- `timingError()` 把 `subagent_session` 映射到两种语言各自的 `timing.subagentSession` 文案，使管理编辑器渲染拒绝原因而非 `rule.error.unknown`。

## Alternatives considered

**移植上游 `toolFilter.deny` preset 行。** 对 CoHarness 不成立：我们的 schedule 工具是 `registerScheduleTools` 挂到 root Agent 上的 agent 作用域注册，不是全局注册名，因此 `deny` 条目会在启动时命中 `tools.restrict()` 的未知名检查而失败。仅 root 注册已使工具不进入子 agent 的 prompt；逐工具的显式拒绝覆盖任何直接执行路径。

**按路由归属而非委派深度拒绝。** 上游第一版以 `hasApiSessionSubagentOwner` 为准、随后收窄为仅深度；我们直接采用最终形态，因为深度 header 正是委派封顶执行的记账。

## Consequences

任何路径——模型工具、管理 UI 或包括自动化在内的其它服务消费方——都无法再为投递永远不可达的 Session 装配或重新武装任务。委派调用方从每个 schedule 工具得到同一个稳定拒绝码。绑定到子 Session 的既有任务仍可列出与删除。

## Verification

`packages/schedule/schedule/tests/subagent-ownership.spec.ts` 固定了对委派子 Session 的服务层 create/update 拒绝以及持续的 list/delete 访问；`tools.spec.ts` 固定四个工具对委派调用方返回拒绝；`task-manager-page.client.spec.tsx` 在非变更 update 结果上渲染 `timing.subagentSession`。Schedule 与 ui-schedule 套件通过（1626 项测试）、干净 typecheck，包依赖策略门禁接受新增的 `dsh-subagent` 依赖边。

## Related

- [Scoped subagent limits](../architecture/2026-09-23-scoped-subagent-limits.zh.md) — 该拒绝读取的委派深度记账。
- [Session reliability fixes](2026-10-12-session-reliability-fixes.zh.md) — 同一 alpha.2 对齐战役。
- 上游提交：`96c421d9857`、`500295b2bdf`、`699f1a8dc18`、`1b1b09e1fbe`。
