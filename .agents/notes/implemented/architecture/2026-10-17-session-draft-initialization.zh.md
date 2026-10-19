# Agent Note: 根事件驱动的 Session 草稿初始化

Status: implemented

[English](2026-10-17-session-draft-initialization.md) | 中文

## 问题

New Session 流程可预填编辑器而不发送消息，该行为对应[上游 PR #5505](https://github.com/deepseek-ai/deepseek-harness/pull/5505)（`c222ea968b02`）。分叉版使用 textarea 与 `InputMachine`、独立于编辑器的引用范围、单独管理的附件，以及会话级 `dsh.conversation.chat` store。预填必须指向导航最终保留的 Session；未显式清空时保留已有草稿；正在提交时拒绝修改；用户发送前不写入 Host 事件。

## 决策

**选项随导航走，而不是随会话查询走。** `IWorkspaces.startSession` 接受 `StartSessionOptions`(`prompt`、`clearPreviousDraft`、`onFailure`);`UiWorkspace.startSession` 转发相同选项，但失败通知由 Workspace UI 的 notice 通道拥有，不再透传 `onFailure`。Workspace runtime 在 `commitSessionNavigation` 的提交回调里发出根级 `conversation/draft-initialize` 事件，寻址到准确保留的 `sessionId`——被取代的导航不发出事件，因此延迟到达的创建结果不可能写进错误的编辑器。

**聊天 store 拥有浏览器草稿持久化。** 初始化监听器在 live shell 有内容时检查其文字，否则检查解码后的存储草稿。尚未恢复存储值的空 shell 不会让已有草稿变成可替换。清空经 `chat.actions.setDraft` 写入，因此重新挂载不会恢复已清除的值。[结构化草稿持久化](2026-10-18-structured-browser-draft-persistence.zh.md)负责引用恢复与旧字符串解码。附件保持独立所有权，初始化不改变附件。

**正在提交的输入优先拒绝。** 监听器与 `InputHub` 的应用路径在任何写入之前都检查 `adjudicating`／`submitting`；被拒绝的变更不会先清空原稿。

**尚不存在的 shell 消费一次挂起的初始化。** `InputHub.pendingInits` 按 Session 保存已解析的请求；`shellFor` 在发布 shell 前消费它，因此第一次输入模型读取就已经拿到初始化后的草稿——不存在 React effect 的恢复窗口，也没有第二个持久写入方。

## 备选方案

**引入上游编辑器及其草稿 store。** 否决：textarea 输入状态机已拥有文字与引用 occurrence。[独立于编辑器的快照](../feature/2026-10-18-rc2-client-surface-parity.zh.md)投影这份状态，不增加另一套编辑器模型；`startSession` 调用方仍只提供 `prompt?: string`。

**在创建时而非导航提交时发出事件。** 否决：被取代或失败的导航仍会把草稿写进用户从未落入的 Session。在提交点对保留的 binding 寻址，才能把写入限定在目标上。

**让 React 挂载 effect 在播种之后应用 prompt。** 否决：挂载 effect 负责把持久文字恢复进空输入，因此显式 `clearPreviousDraft` 会被它要取代的恢复逻辑静默撤销。所有权必须落在 store 写入本身。

## 影响

`StartSessionOptions` 由 client runtime 导出；`SessionInputResolver` 新增 `requestDraftInitialization`,hub 新增不触发创建的 `peek`。catalog 将 `conversation/draft-initialize` 登记为 client-face 事件，文档归 ui-conversation README。不传选项的调用方保持原有 New Session 流程；`prompt` 仅为预填，在用户提交前不产生 `user/message` 或 `turn/start`。

回归覆盖位于 `packages/client/runtime/tests/workspaces-service.client.spec.ts`（提交时发事件、被取代导航、`onFailure`)、`packages/client/ui-conversation/tests/draft-initialization.client.spec.tsx`（预填、保留、清空、live shell 同步、提交拒绝）与 `apps/web/tests/draft-initialization.e2e.ts`（真实组合：跨刷新预填、Workspace 复用的保留与清空、无选项流程、发送前无 Host 事件）。

## 测试

Workspace 服务测试覆盖已提交与被取代的导航；conversation 测试覆盖草稿保留与清除、提交期间拒绝修改，以及结构化恢复。已构建客户端的浏览器场景覆盖跨刷新预填与结构化引用、Workspace 复用，以及提交前不产生 Host 消息。
