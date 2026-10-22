# Agent Note：裸 New Session 在当前 preset 下铸造全新 Session+Agent

状态：implemented

[English](2026-10-18-new-session-fresh-agent.md) | 中文

## 问题

上游 `new-session-generations` 变更让 Web/Desktop 的 New Session 在当前 preset 定义下创建全新的 Session 与 Agent。fork 的 `WorkspaceRuntime.startSession` 此前把每次调用都委托给 `connectWorkspace`，后者复用该 Workspace 首个合格的空白成员——更早手势铸造的 Session 保留其记录的 composition，因此在 preset 变更后点击 New Session 会重新打开过期代次，而不是当前代次。

fork 还持有上游没有的状态：持久草稿预留为每个 Workspace 保存 `draftId` 与预分配 `sessionId` 的对子，池化运行时把 Session 身份限定为浏览器键。在裸启动上命名停放预留的 `sessionId` 会收养其持久化空白——它会按预留记录的 composition 恢复——因此全新语义要求 `session.create` 只携带 Workspace 身份发送。

## 决策

**`startSession` 拆分为两条臂。** 携带 `prompt` 或 `clearPreviousDraft` 的调用保留[空白 Session preset 复用](2026-10-16-blank-session-preset-reuse.zh.md)的草稿准备语义，走 `connectWorkspace`——成员空白扫描、预留采用与草稿交接均不变。两者都不携带的调用走 `connectFreshSession`：以仅含 `workspaceId` 的请求发送 `session.create`，由 Host 铸造身份并自行组装 Agent，成员空白或预留代次都无法把旧 preset 泄漏进来。

**裸臂持有独立的 in-flight 代次。** 同一 Workspace 的并发裸调用合并到同一个 `session.create`；复用 connect 绝不并入它，因为解析出的空白能满足重连契约却不能满足全新 preset 契约。判别依据是草稿选项而非 options 对象是否存在：UI 层总是带上 `onFailure`，因此 `options === undefined` 永远无法表达裸调用。

**既有 Agent 保留其 composition。** 只有 Session 诞生才组装；preset 编辑或 bundle 切换不影响存活 Agent，全局可选工具在受影响 Agent 的下一次请求时刷新。被复用的空白仍属于[复用臂](2026-10-16-blank-session-preset-reuse.zh.md)在请求 preset 下的切换——裸启动只是不再产出它。

## 备选方案

**在裸创建上发送停放预留的 `sessionId`/`draftId`。** 否决：命名预留会按其记录的 composition 收养其持久化空白——正是本变更要消除的过期代次结果——且不会铸造新代次。

**复用成员空白并就地切换其 preset。** 否决：`reuseWorkspaceBlank` 属于以重开同一 Session 为目的的重连臂；落在已列出行的 New Session 还会连带恢复其草稿状态，而不是从空白开始。

**像上游一样以 `options === undefined` 判别。** 否决：fork 的 `UiWorkspace.startSession` 总是把失败观察器包进 options 对象，因此区分草稿准备要看字段内容而非信封。

## 影响

`connectWorkspace` 维持其 Workspace 重连臂契约（`openWorkspace` 回退、启动恢复、携带草稿的启动）；其预留生命周期、池化身份解码与按 preset 合并均不受影响。每次裸 New Session 点击都会持久化一个新的耐久 Session：重复手势不再折叠为同一临时行，且重新加载后每个铸造的代次都留在列表中。

回归覆盖位于 `packages/client/runtime/tests/workspaces-service.client.spec.ts`（裸臂忽略成员空白与停放预留、in-flight 合并按臂隔离、携带草稿的启动仍复用）与 `apps/web/tests/blank-preset-reuse.e2e.ts`（出厂 composition 下越过停放的 `minimal` 成员铸造全新 Agent、既有 Agent 保留 composition）。

## 验证

`packages/client/runtime` workspaces 套件——55 个测试。`apps/web`（host+client 构建产物）：`blank-preset-reuse.e2e.ts`——经真实 Loader composition 的 4 个测试；`workspace-history-entry.e2e.ts`——重复裸手势铸造新的耐久 Session。
