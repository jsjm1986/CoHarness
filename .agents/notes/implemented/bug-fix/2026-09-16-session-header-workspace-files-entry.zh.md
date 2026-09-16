# Agent Note：Workspace 文件入口进入单对话头部

Status: implemented

[English](2026-09-16-session-header-workspace-files-entry.md) | 中文

## 问题

随工作台发布的 Workspace 文件浏览器只把入口注册在 `conversation.workbench.pane.header` 上，因此文件夹按钮只存在于网格面板内，单对话面上没有对应入口。托管（非 loopback）的单 Session 虽然能通过 `openFile` 跳转预览文件，却没有办法打开浏览器本身——单对话里实际看不到 Workspace 文件 UI。

## 决策

同一组 `filesAvailable`/`openFiles` Session 绑定现在也以 `workspace-files` 身份贡献到 `conversation.session.header.utilities`，由 `WorkspaceFilesAction` 渲染。utilities 席位是 Session 级可选运行时工具的归属（open-in-app 已在此），因此该控件落在右对齐工具组而非标题旁的操作行。视口处于工作台模式时该入口返回 `null`：此时每个可见 Session 都位于网格面板内，其 pane 头已带同款按钮，再在每个面板的 Session 头渲染会出现双重入口。可用性沿用 pane 头的规则——远端连接且 `workspaceResources` 对该 Session 的运行时目标存在 provider——因此 loopback 桌面端继续走原生 open-path，不显示失效按钮。

## 备选方案

**把入口从 pane 头整体迁走。** 否决：pane 铬条是工作台面的紧凑操作簇，把控件挪进每个面板的 Session 头会改动已被接受的工作台布局而没有行为收益。

**在两个席位无条件渲染。** 否决：工作台面板同样会挂载 `conversation.session.header`，无条件入口会让每个面板出现两个文件夹按钮。

## 影响

托管运行时上的单对话会在 Session 头工具组显示文件夹按钮，并打开与工作台相同的 `WorkspaceFileBrowser`；工作台面板不变。store、浏览器与预览链路共用，因此从任一表面打开的浏览器都路由到该 Session 自己的运行时目标。

## 验证

`workbench.client.spec.tsx` 覆盖按钮的渲染、点击穿透、工作台模式抑制及无 provider／无 opener 时的隐藏态；`apply.client.spec.ts` 断言 utilities 注册绑定同一组 `filesAvailable`/`openFiles`，并从视口快照上报 `inWorkbench`。
