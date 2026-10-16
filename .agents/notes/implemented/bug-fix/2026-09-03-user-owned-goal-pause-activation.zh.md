# Agent Note: 用户独占的 goal 暂停并暴露实时激活态

Status: implemented

[English](2026-09-03-user-owned-goal-pause-activation.md) | 中文

## 问题

之后的人类轮次仍可通过 `update_goal resume` 解除持久的 `paused` goal，因此用户手动暂停在同轮内仍可被模型工具撤销。远程客户端也无法观察进程本地激活态：只有持久的 `goal` 投影会传输，宿主之外的 active-but-disarmed goal 与 armed goal 无法区分。

## 决策

`ctx.goals.get` 是只读 Remote 方法。`GoalService.setActivation` 集中处理进程本地激活边界：仅在值实际变化时发出 `goal/activation-changed`，载荷为 `{ sessionId, goal: { id, revision, activation } }`，clear 后则不携带 goal；精确当前 ref 取自组合的会话投影，无投影时取自本地增量缓存。`agent/created` 的停用边界与持久 `goal/change` 对账都经由它；`disarm()` 发出边界但不写入持久 revision。API Remote 允许列表把这份 JSON 载荷以 `host/remote-event` 帧转发给客户端。

`update_goal resume` 会在调用 goal 服务前用 `GOAL_TOOL_RESUME_PAUSED` 拒绝持久 paused goal。它仍会在会话恢复或 fork 后恢复 active-but-disarmed goal，并在人类要求继续时恢复 blocked goal。暂停权威仍属于 goal 领域和人类 `/goal resume` 命令，它们仍可恢复每个可恢复 phase。

上游 GoalBar 的激活态显示——区分 armed、disarmed 与 paused goal 的 activation source——另行安排；本次变更交付运行时事件及其转发，不含显示消费方。

## 考虑过的替代方案

**把 activation 存入持久 `GoalSnapshot`。** 否决：按 goal 领域约定，activation 是进程本地的，绝不能跨恢复或 fork 存活。

**把 activation 加入持久 session projection。** 否决：投影状态会写入检查点；缓存的 `armed` 会在武装它的进程消失后继续错误存在。

**把完整的 scoped `goal/changed` 事件转发给客户端。** 否决：其 `Agent` 载荷不是 JSON wire 数据。专用 activation 事件只携带客户端需要的 session id、goal ref 与 activation。

**允许模型从自然语言轮次恢复持久 paused goal。** 否决：人工暂停是用户控制，仅靠提示词约束仍会把同轮撤销能力留给模型。

## 后果

客户端无需持久化 activation 即可区分 armed 与 disarmed goal。持久 paused goal 只能通过 `/goal resume` 或其他直接调用 goal 服务的调用方恢复；模型 `update_goal resume` 仅限 disarmed-active 与 blocked goal。API 表面新增一个读取和一个转发 live 事件；持久 goal change 载荷与投影 stateVersion 不变。在显示消费方交付前，发出的边界服务于远程消费方与测试。

## 测试

Goal 单元测试固定 create、会话启动与 resume 过程中 activation 事件的 id 与 revision，且回放失败路径让 `agent/created` 停用不抛出，而保留的失败仍在读取时浮现。工具测试固定后续人类轮次中持久 paused goal 的拒绝，同时保留已恢复 disarmed-active goal 的恢复。api-proxy 测试固定 `host/remote-event` JSON 转发。
