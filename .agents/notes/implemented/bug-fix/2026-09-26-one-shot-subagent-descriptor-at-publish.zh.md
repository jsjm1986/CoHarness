# Agent Note：Agent Teams 按持久 session origin 分类子代理

Status: implemented

[English](2026-09-26-one-shot-subagent-descriptor-at-publish.md) | 中文

## 问题

Agent Teams roster 的 `tryMembership` 通过折叠子 Session 自身事件中的 `subagent/descriptor` 记录来区分「provider 持有的子代理」与「隐式 Team 根」。in-process 一次性驱动器只在子代理首个 `agent/pre-step` 准入该 turn 时才追加 descriptor——该事件按设计是「已获准执行」的证明，因此每个 `agent/created` 观察者都运行在判别依据持久化之前。父代理存活时，普通的 `tools.subagent` 子代理被误分类为隐式 Team Lead：`tool-agent-team` 为其装上了完整的 Team 作用域，而当 descriptor 落盘后，`team:policy` 提示词 section 的严格 `membership()` 读取抛出 `TEAM_NOT_MEMBER`，把子的 turn 以笼统的 `subagent run failed` 终结——此时被委派的工作其实已经执行成功。

## 决策

[TeamRoster.subagentDescriptor](../../../../packages/experimental/agent-team/src/roster.ts) 把 `session.header.origin === "subagent"` 作为第一分类依据：`childSessionMeta` 在创建时把该标记写入持久 session header，因此在 `agent/created` 公告子代理之前已经可见。descriptor 折叠仍是旧 session（origin 字段出现之前创建）以及已携带该事件的冷恢复子代理的权威。

## 已考虑的备选方案

**在未发布的 `setup` 期间追加 descriptor。** 这能让标记在 `agent/created` 前持久，但会删掉一条承载性的排序契约：workflow 门禁可以把 spawned 子挡在首个 `agent/pre-step`，descriptor 的存在必须继续证明子真正进入过执行。被拦住的子会携带该记录却从未运行。

**把 Team 安装推迟到 `agent/created` 之后。** microtask 或首步安装仍然暴露创建与观察之间的分类缺口，而且由 `session/event` 驱动的卸载会让 Team 工具在子的第一个 step 里对模型可见。

**查询存活注册表而非持久日志。** `establishCatalogChild` 只在 `provider.start` resolve 之后才写父侧的 `subagent/catalog` 记录，晚于 `agent/created`；父侧记录存在同样的时序缺口，而且在 session header 已携带该事实的情况下平添一层依赖。

**让 `team:policy` 改用 `tryMembership` 渲染。** 吞掉严格读取只会掩盖未来的误分类而不是修复它；该 section 只向成员安装，严格失败仍是正确的告警。

## 后果

roster 的分类不再依赖事件折叠时序，因此任何观察者顺序——`agent/created`、`agent/status`、冷恢复——都能正确解析 provider 持有的子代理。roster 成员身份仍优先于 origin 检查：rostered continuable 子上的 `origin: "subagent"` 不会把它降级成非成员。进程外 provider（`dsh-sdk`、ACP）在独立进程中创建子代理，不受影响。
