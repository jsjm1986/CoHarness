# Agent Note：Agent Team 面板保持只读

Status: implemented

[English](2026-10-12-agent-team-panel-read-only.md) | 中文

## 问题

Web Agent Teams 页头面板在 `agentTeams/createTask` 与 `agentTeams/updateTask` RPC 之上维护了一套手写 mutation 界面——任务创建/编辑表单、owner 下拉框，以及完成/重开/删除操作。上游 DeepSeek Harness 在 `dsh-v0.2.0-rc.1` 已移除该界面，只保留只读 roster 与任务板。继续保留本地 mutation 路径意味着要自己维护上游已不再维护或验证的 compare-and-set revision 处理、冲突恢复文案与表单状态。

## 决策

[client-ui-agent-team](../../../../packages/experimental/client-ui-agent-team/README.zh.md) 渲染只读任务板：`TeamActionInjected` 收窄为 `load` 与 `openTeammate`；任务区展示 identity、status、owner、blocker、readiness、write scope 与 warning，并支持描述折叠展开；locale 字典与测试移除全部 mutation 控件。任务修改仍由 agent 通过 [agent-team](../../../../packages/experimental/agent-team/README.zh.md) 的 Team 工具完成；RPC 方法本身未改动，因此没有服务、projection 或 wire contract 变化。

面板锚定到页头触发器的右边缘（`right: 0`），并在 768px 以下退化为固定底部面板，使右侧触发器不再把内容推出视口。

## 备选方案

**在现有 RPC 之上保留 mutation UI。** 服务端方法仍然可用，但表单将永远偏离上游：每一次上游面板变更都需要与一个上游已删除的界面手工合并，而 Team 工具已覆盖同一流程。

**一并移除 RPC 方法。** 超出范围——其他调用方可能仍在使用 `createTask`/`updateTask`，contract 移除属于 [agent-team](../../../../packages/experimental/agent-team/README.zh.md) 的决策，而非面板决策。

## 影响

人类用户失去手动录入任务的能力；他们可以查看任务板并导航 teammate，agent 保留完整任务控制。面板减少约 290 行表单、revision 与冲突恢复逻辑，测试改为锁定只读渲染以及保留的 load/refresh/导航行为。注入面收窄为两个回调，简化了未来的 mount 变更。
