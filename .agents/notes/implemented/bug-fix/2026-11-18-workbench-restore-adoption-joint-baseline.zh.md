# Agent Note: 工作台恢复采纳必须等待 sessions/workspaces 联合基线

Status: implemented

[English](2026-11-18-workbench-restore-adoption-joint-baseline.md) | 中文

## Problem

`ConversationViewportController.markCatalogReady()` 在 catalog 水合完成时立即把恢复布局的活动 pane 采纳为当前会话，直接调用 `select(state.activePaneId)`。catalog 水合经账户 workbench-catalog 与历史读取完成，可能在 `workspaces.list` 仍为 `pending` 时就绪——而 `reconcileSessions()` 明确要求联合基线才能采纳。这次过早的 `select` 把 `sessions.current` 移到了保存的 pane 上，而 `RightbarRoot` 在没有显式 `targetSessionId` 固定时总是跟随 `current`，于是文档预览侧栏在 `workspace.list` 就绪前就渲染了出来。`workbench.e2e.ts` 的 `keeps the originating conversation selected when its document preview narrows the workbench` 对 `workspace.list` 设了门控，观察到 `preview-origin-beta` 在基线完成前已经可见，连续三个 CI run 失败。

## Decision

所有恢复期的采纳现在都收敛到 `selectWorkbenchFocus()`：它在 `baselineReady` 之前拒绝移动 `current`——该标志只由 `reconcileSessions()` 在 `sessions.list` 与 `workspaces.list` 都报告 `ready` 后置位。`markCatalogReady()` 改为调用它而不是直接 `select`,`setEnabled()` 的再采纳路径也走同一道门，因此 catalog 就绪或客户端启用单独都无法采纳 pane。

`baselineReady` 的构造期种子值也被修正为同一联合定义：当 controller 构建时 `sessions.list` 已 `ready` 而 `workspaces.list` 仍 `pending`，不再被当作已建基线。原先仅看 sessions 的种子既提前放行了恢复采纳，又会在 workspaces 迟到时永久压制 `firstBaseline` 采纳。

## Alternatives considered

- 只给 `markCatalogReady()` 加门——否决：`setEnabled()` 共享同一条直接 select 的采纳路径，只修一个调用点会让下一个恢复触发器重放同一竞态。收敛到 `selectWorkbenchFocus()` 使契约单一来源。
- 在 `select()` 内部加 `baselineReady` 门——否决：`select()` 同时是用户手势路径（focus、add、remove、pane 切换）,这些调用方不能等待一个它们早已拥有的基线。
- 改为等待 `pendingIdentity` 清除——否决：`pendingIdentity` 覆盖的是 v2 不透明键重写，是另一种待定状态；失败路径是 v3 记录，pane 已验证、只是 workspace 基线尚未到达。

## Consequences

- `reconcileSessions()` 里的 `firstBaseline` 采纳重新成为把 `current` 移到恢复 pane 的唯一入口；在"构造时 sessions 已 ready、workspaces 迟到"的时序下它现在会正常触发，而旧种子会把它吞掉。
- 用户驱动的切换与复制仍经 `switchWorkbench`/`duplicateWorkbench` → `selectWorkbenchFocus()` select；用户能切换时基线早已就绪，行为不变。
- 会话缺失或已归档的 pane 仍被同一道 `validSession` 检查拒绝；unavailable-pane 的停放语义不受影响。

## Verification

- 新增回归 `does not adopt the restored active pane before the joint sessions/workspaces baseline resolves`（位于 `packages/client/ui-conversation/tests/viewport.client.spec.ts`):sessions 与 workspaces 列表均为 `pending`,v3 账户记录经 `setPaneVerification({})` 完成验证——`markCatalogReady()` 不触碰 `sessions.open`，直到 `workspaces.list` 就绪后由 `firstBaseline` reconcile 采纳该 pane。stash 修复后该测试在第一条断言处确定性失败。
- `viewport.client.spec.ts` 29/29；工作台持久化、运行时归属、选择存活三个 spec 合计 60/60。
- `apps/web` CI 的 `web verification` 此前连续三个 run 败在同一场景；本修复正对测试所门控的时序。
