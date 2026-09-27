# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件提供唯一的三栏 AppFrame、拖动尺寸与窄屏抽屉。它在 `root` 下声明左侧 `sidebar`、中间 `conversation`、右侧 `rightbar`、浮动层及移动顶栏操作。四会话 Workbench 保持为唯一的中间会话容器；右侧栏的标签、分栏与开合由 [ui-sidebar-right](../ui-sidebar-right/README.zh.md) 管理，框架只消费其呈现报告并分配空间。主题呈现器负责配色、别名 token、正文字号与 document 元数据。

框架发布 `data-viewport` 与 `--dsw-viewport-height`，以支持窄窗格和屏幕键盘。medium 模式保留导航控制栏，右侧栏覆盖中间内容；compact 模式使用左侧抽屉和全屏辅助栏。遮罩和 Escape 将关闭请求交给标签状态所有者，不直接改写另一份开合状态。侧边抽屉关闭后恢复顶栏开关焦点。框架尺寸不写入 localStorage，Session 标签的恢复规则由右侧栏负责。

`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController` 和 owner-share 接口（包括 `MobileHeaderActionOwnerProps`）。AppFrame、面板 store 与让步求解器仍属于包内部。

`layout.openDetails(sessionId, target)` 把工具调用交给唯一的辅助栏所有者；`target.callId` 明确指定调用，标签不依赖聊天中当前选中的调用。`layout.focusRightbar(sessionId)` 只切换辅助栏目标，不改变中间窗格选择。辅助栏向框架报告是否显示、是否占轨道以及是否全屏；折叠不会结束 Host Session。

## 概述

本包提供 Web GUI 的三栏 AppFrame、左右栏宽度与 `ctx.layout` 呈现控制。右栏先让步以保护中栏空间，全屏由占用方呈现，框架保留宽屏底层轨道。主题呈现器负责配色、别名 token、正文字号与 document 元数据；布局状态在刷新后重置。

## 不变量

**运行时不变量：** 未发布配套入口。面板几何与折叠是展示层本地的服务状态；框架的 slot 注册通过 HMR 安全性规格证明其释放。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **面板尺寸是瞬时状态**：刷新后恢复默认宽度；账号与 Session 的标签、开合和分栏记录由右侧栏恢复。
- **空间不足时收起辅助栏**：框架报告可用空间，由标签所有者决定收起；宽度偏好不代表实际可见状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
