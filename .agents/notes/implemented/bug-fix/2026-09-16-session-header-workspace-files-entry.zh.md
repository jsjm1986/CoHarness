# Agent Note：Workspace 文件入口进入单对话头部

Status: implemented

[English](2026-09-16-session-header-workspace-files-entry.md) | 中文

## 问题

随工作台发布的 Workspace 文件浏览器只把入口注册在 `conversation.workbench.pane.header` 上，因此文件夹按钮只存在于网格面板内，单对话面上没有对应入口。托管（非 loopback）的单 Session 虽然能通过 `openFile` 跳转预览文件，却没有办法打开浏览器本身——单对话里实际看不到 Workspace 文件 UI。

## 决策

`WorkbenchToolbar` 现在自行提供文件浏览入口：一对 `filesAvailable`/`openFiles` 注入在工具栏操作组渲染同款文件夹图标按钮。工具栏本就挂载在每个会话面上——工作台模式下是网格顶行，单对话视图里是 Session 头的 `leading` 席位——一次注册即覆盖两个面。工具栏绑定在调用时解析目标 Session：工作台模式取活动面板，否则取 `sessions.list.current`，然后沿用 pane 头的可用性规则——远端连接且 `workspaceResources` 对该 Session 的运行时目标存在 provider——因此 loopback 桌面端继续走原生 open-path，不显示失效按钮。每个面板的 pane 头按钮保留为逐面板直控入口；工具栏入口是已发布 e2e 契约所描述的面级对应物。

## 备选方案

**在 `conversation.session.header.utilities` 注册第二个入口。** 否决：Session 头在每个工作台面板内同样挂载，无条件入口会让每个面板出现双重按钮，而按 `mode === 'workbench'` 抑制会引入工具栏方案本不需要的模式谓词。

**工具栏入口绑定固定 Session。** 否决：工具栏在会话切换后仍然存在，绑定必须在调用时解析活动 Session，而不是在注入时捕获一个。

## 影响

托管运行时上的单对话会在其 Session 头内的工作台工具栏席位显示文件夹按钮，并打开与工作台相同的 `WorkspaceFileBrowser`；工作台面板不变。store、浏览器与预览链路共用，因此从任一表面打开的浏览器都路由到目标 Session 自己的运行时目标。

## 验证

`workbench.client.spec.tsx` 覆盖工具栏按钮的渲染、点击穿透及无 provider／无 opener 时的隐藏态；`apply.client.spec.ts` 断言工具栏注入在工作台模式解析活动面板 Session、在单对话模式解析当前 Session；`apps/web/tests/workspace-files.e2e.ts` 驱动真实浏览器经工具栏按钮打开实时预览。
