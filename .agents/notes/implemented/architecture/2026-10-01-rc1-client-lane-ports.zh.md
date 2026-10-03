# Agent Note: 上游 rc.1 客户端通道行为移植

Status: implemented

[English](2026-10-01-rc1-client-lane-ports.md) | 中文

## 问题

[rc1 客户端通道审计](../../proposed/architecture/2026-09-30-rc1-client-lane-audit.zh.md)裁决了所有仅上游存在的客户端包；若干行指出的是本地确实缺失的行为缺口而非结构性分叉。其中四项是用户可见的：右侧栏没有保留会话的视图、焦点捕获或快捷键目标模型；`RunningToolCall` 的 preparing 阶段由会读取尚在流式传输中的已派发参数的执行行渲染；workspace 浏览器已有 `pinSession` Host RPC 却没有 UI 排序或菜单入口；以及 `ui-layout` 的左侧栏绑键与移植来的 `sidebar.right.toggle` 撞车，使真实组合无法启动。

## 决策

每项行为都落在本地 session-store 模型上，而不是上游的 controller 包结构。

- **`ui-sidebar-right` 保留与焦点**——`SidebarSessionViews` 经 runtime `sessions` 引用选择并保留视图；每个 View 持有自己的 Session 引用，`keepMounted` 正文在切 tab、切会话与收起之间不重新挂载。`sidebarTargetFromElement`/`visibleSidebarPane` 捕获聚焦的停靠格或浮窗 occurrence；`registerSidebarShortcuts` 把 `sidebar.right.toggle`、`pane.split`、`pane.fullscreen.toggle`、`page.close`、`page.refresh` 绑定到 `commandTarget`/`focusedTarget`/`isTargetCurrent`，`page.close` 的模态解散片段由 `closeTopModal` 承担。
- **Preparing 行**——`phase: 'preparing'` 经 `CordisPreparingRow`、`PreparingPresentRow` 与 `SkillRow` 分支；keyed toolview 卡片在参数流式期间不再读取参数，Cordis 行失败时保留工具字形而不再替换为 `StateDot`。共享 `DisclosureRow` 增加 `running`/`contentClassName`/`contentLayoutClassName` 属性与 `TextShimmer` 原语，以及驱动活跃生命周期文案的 `--dsw-alias-label-shimmer` 主题 token。
- **Workspace 置顶**——`pinnedSessionIds` 进入 workspace 行状态；置顶行在各分区内领先并保持区内次序且只能彼此重排。`pinSession`/`unpinSession` 走既有 Host RPC，`pin-order.ts` 经 `pinOrderSource` 调和分组与扁平账户的次序。
- **Agent Teams 描述折叠**——`TaskCard` 把描述折叠在两行并用 `ResizeObserver` 测量真实折叠后才提供展开开关。
- **快捷键绑键**——`sidebar.left.toggle` 保持上游的桌面 `primary`/web `primary+alt`，把 `primary+alt`/`primary+shift` 留给右侧栏。

## 备选方案

**逐字采用上游的 `session-view.ts` 保留机制。** 否决：它写在本分叉不携带的 controller `SessionReferenceSourceMap` 上；`SidebarSessionViews` 在 runtime 对象层上保留了相同的保留语义。

**在 preparing 分支旁保留 `StateDot` 状态指示。** 否决：上游修复让每种状态都保留工具字形、经错误摘要传达失败，因此指示符在两处元素里重复了同一事实。

**因为已有拖拽排序而不做置顶排序。** 否决：拖拽持久化手工次序，置顶是有自己 RPC 的成员集合；两者是组合而非重叠。

## 影响

- 真实组合启动时不再有撞车的快捷键默认值；桌面与 Web 绑键是有意不同的。
- 每个 `phase: 'preparing'` 界面渲染不可展开的 shimmer 行，且不触碰执行或清单 hook。
- `verify-client-packages` 现在要求 `ui-sidebar-right` 的 `dsh.client.inject` 行命名 `dsh-client-shortcuts`。

## 测试

`ui-sidebar-right` 持有 258 个聚焦 spec 覆盖保留、焦点捕获与命令解析；真实组合 spec（15 个测试）证明无快捷键撞车。Cordis status-icon、present-row 与 skill-row spec 钉住 preparing 分支；workspace tree/rows spec 钉住排序与菜单接线。
