# Agent Note: 根事件驱动的 Session 草稿初始化

Status: implemented

[English](2026-10-17-session-draft-initialization.md) | 中文

## 问题

上游 PR #5505(`c222ea968b02`)把 `startSession(workspaceId?, options?)` 扩展为携带 `prompt` 与 `clearPreviousDraft`，使 New Session 流程能预填编辑器草稿而不发送，并让结构化草稿 store 成为初始化 owner。本地 composer 是 textarea 加 `InputMachine` 的架构：草稿为纯文本，附件独立记账，会话级聊天 store(`dsh.conversation.chat`)负责镜像草稿以持久化——上游那套 Lexical/结构化 chip 机制在本地并不存在。值得移植的是用户可见契约：预填只落在导航最终保留的 Session 上；未显式清空时保留已有草稿；正在提交的输入拒绝该变更；用户发送前不写入任何 Host 日志。

## 决策

**选项随导航走，而不是随会话查询走。** `IWorkspaces.startSession` 接受 `StartSessionOptions`(`prompt`、`clearPreviousDraft`、`onFailure`);`UiWorkspace.startSession` 转发相同选项，但失败通知由 Workspace UI 的 notice 通道拥有，不再透传 `onFailure`。Workspace runtime 在 `commitSessionNavigation` 的提交回调里发出根级 `conversation/draft-initialize` 事件，寻址到准确保留的 `sessionId`——被取代的导航不发出事件，因此延迟到达的创建结果不可能写进错误的编辑器。

**聊天 store 仍是唯一的持久草稿 owner。** ui-conversation 的监听器按下述规则判定现有草稿：shell 持有文字时以 shell 为准，否则以持久化 store 为准——一个尚未从 store 播种的空 shell 不会让受保护的草稿变成"可预填"。清空经 `chat.actions.setDraft` 写穿持久层，因此被清空的草稿不会在下次挂载时被重新播种，预填的草稿则能跨重新挂载与刷新保留。附件在任何分支都不受影响。

**正在提交的输入优先拒绝。** 监听器与 `InputHub` 的应用路径在任何写入之前都检查 `adjudicating`／`submitting`；被拒绝的变更不会先清空原稿。

**尚不存在的 shell 消费一次挂起的初始化。** `InputHub.pendingInits` 按 Session 保存已解析的请求；`shellFor` 在发布 shell 前消费它，因此第一次输入模型读取就已经拿到初始化后的草稿——不存在 React effect 的恢复窗口，也没有第二个持久写入方。

## 备选方案

**移植上游的结构化 `DraftSnapshot` 与 chip 恢复。** 否决：本地输入是 textarea 状态机，结构化模型属于另一种编辑器架构；而且上游暴露给 `startSession` 调用方的本来就只有 `prompt?: string`。

**在创建时而非导航提交时发出事件。** 否决：被取代或失败的导航仍会把草稿写进用户从未落入的 Session。在提交点对保留的 binding 寻址，才能把写入限定在目标上。

**让 React 挂载 effect 在播种之后应用 prompt。** 否决：挂载 effect 负责把持久文字恢复进空输入，因此显式 `clearPreviousDraft` 会被它要取代的恢复逻辑静默撤销。所有权必须落在 store 写入本身。

## 影响

`StartSessionOptions` 由 client runtime 导出；`SessionInputResolver` 新增 `requestDraftInitialization`,hub 新增不触发创建的 `peek`。catalog 将 `conversation/draft-initialize` 登记为 client-face 事件，文档归 ui-conversation README。不传选项的调用方保持原有 New Session 流程；`prompt` 仅为预填，在用户提交前不产生 `user/message` 或 `turn/start`。

回归覆盖位于 `packages/client/runtime/tests/workspaces-service.client.spec.ts`（提交时发事件、被取代导航、`onFailure`)、`packages/client/ui-conversation/tests/draft-initialization.client.spec.tsx`（预填、保留、清空、live shell 同步、提交拒绝）与 `apps/web/tests/draft-initialization.e2e.ts`（真实组合：跨刷新预填、Workspace 复用的保留与清空、无选项流程、发送前无 Host 事件）。

## 测试

`packages/client/runtime`:workspaces 套件——52 项测试。`packages/client/ui-conversation`：全量套件——714 项测试。`apps/web`（已构建 client bundle):`draft-initialization.e2e.ts`——3 项测试，走真实 Loader 组合。
