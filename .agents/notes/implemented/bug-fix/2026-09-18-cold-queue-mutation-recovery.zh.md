# Agent Note：为 Inbox 命令恢复冷会话

状态：已实现

[English](2026-09-18-cold-queue-mutation-recovery.md) | 中文

## 问题

Inbox 状态持久保存在会话日志中，但此前 `session.updateQueue` 只查找存活 Agent。Host 重启后，普通持久化 Session 在有操作需要其 Agent 之前保持冷态，因此编辑或移除已恢复的 pending 项会错误地返回 `queue-item-not-found`。

## 决策

`session.updateQueue` 在读取或修改 Inbox 之前，先经共享 Agent resolver（`agentFor`，由 `createApiRemoteAgentResolver` 构建）解析普通冷 Session。持久化 Session 缺失或 persistence 后端缺席仍映射为 `queue-item-not-found`，其它恢复失败保留原有错误，subagent 所有权沿用与其它 Agent 操作相同的围栏。

解析得到的 Agent 从已注册的持久投影构建 Inbox。命令因此能读到恢复的 pending 列表，并通过现有的规范化 `agent/inbox/spliced` 事件记录编辑或移除。不引入新的 session 事件或磁盘格式。

共享 resolver 在 resume 落定后重新应用存活所有权围栏：共享 resume 发布的身份可能在所有等待者观察到之前就被 subagent 路由收养，因此落定后的 `fencedLiveAgent` 检查优先于返回的句柄。

## 验证

冷操作测试提供一个带 pending Inbox splice 的分离持久化 Session，调用 `session.updateQueue`，证明该 Session 被恢复、行被移除、且持久化移除 splice 已追加。退化组合测试证明无 persistence 后端时返回 `queue-item-not-found`。

## 已否决的替代方案

**把一切缺失的存活 Agent 视为缺失的队列项。** 否决，因为 persistence 可能仍持有该普通 Session 及其持久 Inbox 投影。

**在 `session.updateQueue` 内部折叠会话日志。** 否决，因为 Inbox 投影已拥有重建职责，而共享 Agent resolver 拥有冷生命周期装配与预设组合。

## 后果

对已恢复 Inbox 行的操作使用与存活行相同的预设组合、所有权检查和持久变更路径。读取持久状态本身不需要提前恢复 Agent；只有显式命令才恢复普通 Agent。`session.cancel` 刻意保持仅存活路径：取消冷 Session 的 turn 是无操作，而非恢复场景。
