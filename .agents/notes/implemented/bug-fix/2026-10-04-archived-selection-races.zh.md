# Agent Note: 闭合连接与 prompt 准入上的归档选择竞态

Status: implemented

[English](2026-10-04-archived-selection-races.md) | 中文

## 问题

三处缺口让在客户端离线期间被归档的会话表现得像活会话。重连时会话列表先于 Workspace 归档基线解析，恢复的 `dsh.sessions.current` id 带着可用输入框挂载，而 `session.prompt` 会接受输入——两侧都不拒绝已归档会话。基线落地后，池化聚合层掩掉了 `current`，但持有该选择的运行时仍保留它，于是 per-runtime 持久化投影重新写入该归档 id，每次刷新都重新挂载僵尸会话；Workspace 层的清扫读的是已被掩掉的聚合视图，对恢复场景永远不会触发。`startInitialSelection` 还缺少所有兄弟导航提交都做的归档并集复查。

## 决策

**归档掩码在持有方运行时去选，prompt 准入放在服务端。** `SessionRuntimePool.rebuild` 中，原始 `current` 落入其目标归档集的 entry 通过 `releaseSelection` 去选——这是比 `clear` 更窄的原语：丢弃选择与持久化单元但不中止在途导航意图。当 `workspaceRegistry.archivedSessionIds` 包含该 id 时，`session.prompt` 返回 `session-archived`（`pinSession` 已在用的错误码），使残留的连接窗口无论客户端状态如何都不会造成输入执行；未组合 Workspace Registry 的最小部署跳过该检查。`startInitialSelection` 的提交在 `sessions.open` 前复查 `archivedById`/`archivedSessionIds`，与 `selectWorkspace`、`uiWorkspace.openSession` 对齐。

## 文件

- `packages/host/apiproxy/src/api-proxy.ts` — `session.prompt` 归档准入返回 `session-archived`。
- `packages/client/runtime/src/client/sessions/pool.ts` — `maskedSelections` 收集与发布后 `releaseSelection`。
- `packages/client/runtime/src/client/sessions/service.ts` — `clear` 旁新增 `releaseSelection`。
- `packages/client/runtime/src/client/workspaces/service.ts` — 初始选择提交中的归档并集复查。
- `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`、`packages/client/runtime/tests/{session-pool,workspaces-service}.client.spec.ts` — prompt 拒绝、持有方去选、提交中归档的覆盖。

## 后果

在他处被归档的会话不再能接受 prompt 或在刷新后重新挂载：基线掩掉时持久化选择单元被清除，服务端在连接窗口内用客户端已认识的错误码拒绝输入。掩码永远不会取消在途导航——`releaseSelection` 刻意不调用 `beginNavigation`，因此与归档帧竞速的初始选择通过既有 `waiting` 路径重试，而不是死锁在 `opening`。读取路径（`session.history`、attach）对已归档会话仍然放行；只有输入准入发生了变化。
