# Agent Note：workflow 成员导航按展示键空间重键

状态：已实现

[English](2026-10-04-workflow-member-session-key.md) | 中文

## 问题

持久化的 `workflow/agent-start` 事件携带原始 wire `childId`（`SessionId`）。`WorkflowRunPanel` 把它直接与 `sessions.ids`/`sessions.byId` 比较，但 `sessions` 服务恒为 `SessionRuntimePool`，其投影把每个 id 经 `clientSessionKey` 重写为 `dsh-session:v1:` 键。原始 id 不可能出现在列表中，`navigableMembers` 永远返回 `[]`，成员行永远拿不到点击回调——workflow 成员导航在任何部署里都是死的。

## 决定

面板在触碰会话列表前对持久 id 重键，沿用 ui-schedule 与 agent-team 的归一化模式。`WorkflowRunInjected` 新增 `sessionKey(id, parentId)`，在 `apply` 中接到 `ctx.sessions.keyFor(id, runtimeIdentityFor(parentId))`，服务缺 `keyFor` 时回退恒等。`navigableMembers` 与 `MemberRow` 以限定键比较和打开；`openSession` 收到展示键直接传入（`pool.open` 接受限定 id）。持久事件保持原始——只有比较边界做重键。

## 文件

- `packages/client/ui-workflow-run/src/client/index.ts` — 从 `ctx.sessions` 注入 `sessionKey`。
- `packages/client/ui-workflow-run/src/client/WorkflowRunPanel.tsx` — `navigableMembers`、`PhaseSection`、`MemberRow` 改为操作展示键。
- `packages/client/ui-workflow-run/tests/workflow-run.client.spec.ts` — 覆盖原始 `childId` 命中限定键列表的回归。

## 影响

运行时子代理成员在池化列表证明父子关系后可从 workflow 面板打开其会话。其他拿 `childId` 类持久 id 与 `sessions.ids`/`byId` 比较的面板需要同样的 `keyFor` 归一化；新代码应在展示键空间比较，永不直接比 wire 空间。
