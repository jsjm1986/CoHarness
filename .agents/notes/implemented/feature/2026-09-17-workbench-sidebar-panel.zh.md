# Agent Note：工作台侧栏面板与面板级 markdown 表格

状态：已实现

[English](2026-09-17-workbench-sidebar-panel.md) | 中文

## 问题

工作台模式存在两处缺口。较窄的分栏会裁掉 markdown 表格：单元格宽度上限使用相对整个浏览器窗口的 `30vw`，而不是相对分栏；宽表保持 `overflow-x: hidden` 直到悬停，因此约 390px 的分栏会无声裁掉宽内容。另一方面，侧栏浏览区在工作台模式下只剩一条空白提示，分栏清单和账户级显示偏好（字号、内容宽度）在工作台模式下没有可达界面。

## 决策

Markdown：仅在 `[data-workbench]` 下，让 `.tableScroll` 叶子盒成为 `inline-size` 查询容器，使单元格上限按分栏文本列解析为 `30cqw`；`md-table-wide` 立即可滚动，不再等悬停。查询容器之外的 `cqw` 仍按小视口解析，因此单会话渲染不受影响。

侧栏：`WorkspaceBrowser` 声明子孔位 `sidebar.workspaces.workbench`，并在工作台模式下用它替换自身的 Workspace/Session 列表、分节头和 rail 搜索。`ui-workbench` 以 `WorkbenchSidebar` 填充——分栏清单（状态点、Workspace 前缀标题、聚焦与关闭）、绑定共享选择器 store 的 Add、等宽操作与退出控件——并在同一注册上声明 `conversation.workbench.display` 孔位。`ui-conversation` 以 `WorkbenchDisplayRow` 填充该孔位：通用显示设置行的堆叠变体，绑定同一个 `ConversationDisplaySettings` face，因此分栏旁的偏好设置与设置面板共用同一个账户 revision 栅栏。

## 备选方案

**在 `.workbenchPane` 上加 `container-type: inline-size`。** 否决：多个非 portal 的 `position: fixed` 后代位于分栏内部（`SessionSettingsSheet`、`ContextMeter` 弹层、`stat-dialog`）；容器化会把它们重新锚定到分栏并被其 `overflow: hidden` 裁掉。叶子滚动盒没有定位后代，因此在该处容器化除查询单位外不改变行为。

**把显示孔位命名为 `sidebar.workspaces.workbench.display` 并让 ui-conversation 填充。** 否决：SlotMap 合并会落到 workspace 域，使 ui-conversation 的契约依赖侧栏包；孔位保留在 `conversation.workbench.*` 下让合并留在显示偏好域的属主处，且不新增模块边——ui-workbench 已经以类型方式引用 ui-conversation。

**在面板里复制工具栏的命名工作台菜单。** 否决：工具栏已拥有切换/新建/重命名/复制/删除；第二个菜单会把同一个入口拆到两处界面。

## 影响

工作台分栏按自身列宽约束 markdown 表格，宽表保持可滚动。工作台模式下浏览区承载分栏管理与显示偏好；显示偏好的契约文本仍归 conversation 域所有。命名工作台管理仍专属于工具栏。[工作台能力笔记](../architecture/2026-09-08-cordis-multi-session-workbench.zh.md) 继续负责 viewport 模型；本笔记只覆盖其上新加的侧栏呈现。

## 验证

`ui-workbench` 的组装测试通过真实 slot runtime 挂载 workspace、conversation 与 workbench 插件，断言渲染出的清单、聚焦/等宽/退出操作、共享选择器的打开，以及显示行经 settings scope 写入。样式契约测试固定 `[data-workbench]` 作用域的 `cqw` 容器与宽表溢出行为；工作台组件测试覆盖添加/等宽的禁用边界与空状态。
