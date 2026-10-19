# Agent Note：Workspace 文件预览的原生打开回退

Status: implemented

[English](2026-10-18-workspace-file-preview-native-open.md) | 中文

## Problem

侧边栏预览无法渲染的 Workspace 文件会退回到有界的只读 Base64 窗口——字节可见，但要在外部程序中打开该文件只能离开预览。上游的做法是在不可预览文件的空状态中复用其 opener；本组合此前没有对应的出口。

## Decision

[`WorkspaceFilePreview`](../../../../packages/client/ui-workbench/src/client/components/WorkspaceFilePreview.tsx) 的二进制回退现在在字节窗口上方提供默认应用打开操作，但仅在服务端 Host 具备原生路径打开能力时出现。该操作调用 `workspaces.openPath`——与会话 `openFile` 使用的同一授权 RPC——并通过 `resolveWorkspacePath` 将工作区相对请求路径解析到会话 `cwd` 下。

能力门与会话 `openFile` 的检查完全一致：`connection.isLoopback` 且会话 runtime 目标解析为 `base` 且 Host 描述声明 `executionAuthorityRequired === false` 与 `canOpenPath`。远程/Gateway 会话与项目 runtime 不显示该控件，操作在 RPC 之前即被拒绝。inject 面将门暴露为 `nativeOpenAvailable()`——与 `filesAvailable` 一样在渲染期求值，首个挂载后才到达的能力在下一次渲染出现——以及 `openNativePath(request)`，后者在解析路径前重新校验会话当前 runtime 仍持有该请求（与 `openResource` 相同的所有权围栏）。

标签把该手势作为可选 `nativeOpen` prop 下传；缺省时回退界面只剩字节预览。打开失败经预览已有的 alert 行呈现，有界字节内容保持显示。

完整的选择器变体（默认应用加已注册处理程序加文件管理器显示）由 ui-deliverables 的 `NativeOpenMenu` 承载，该组件为包内私有且绑定其 presented-file 类型；若日后出现第二个消费方，文件卡片面的完整选择器才是上提合并点。

## Alternatives considered

- **引入 `NativeOpenMenu`** 被否决：跨包引用其他插件符号违反规则，且该菜单需要 `host.fileApplications` 关联读取，预览本身并不需要。
- **为空状态增设 slot 孔位**（上游的 `…unpreviewable` 孔位）被否决为不成比例：本组合中文件预览是普通的 owner-prop 组件，只需新增一个可选回调。

## Testing

`workspace-preview.client.spec.tsx` 覆盖：手势 prop 存在时操作出现并可调用、缺省时隐藏、打开失败在 alert 行呈现且有界字节保持显示。`apply.client.spec.ts` 通过真实插件组合端到端覆盖 inject 面：具备能力的基础 loopback 以解析后的 Workspace 路径调用 `openPath`；项目目标、无能力或缺失的 Host 描述、非 loopback 传输以及会话 runtime 迁移分别隐藏并拒绝操作。`workspace-file-tab.client.spec.tsx` 在其手工构建的 face 上补齐了新的 inject 成员。

## Consequences

- 按钮只出现在二进制回退空状态中；图片、文本与文档预览不变。
- 能力可见性在渲染期求值而非响应式：`canOpenPath` 在两次渲染之间翻转时控件在下一次绘制出现或隐藏，操作本身在调用前再次校验。
- 不改变任何 wire、session-log 或 Host 契约；`host.openPath` 与 `resolveWorkspacePath` 均为既有授权路径。
- [Workspace 文件链接](../feature/2026-07-31-web-workspace-file-links.zh.md) note 仍拥有 `openPath` 的理由与本回退所继承的非本地客户端范围。
