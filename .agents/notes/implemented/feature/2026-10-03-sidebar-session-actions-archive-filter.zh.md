# Agent Note: 插槽化的会话行操作与侧边栏归档筛选

状态： 已实现

[English](2026-10-03-sidebar-session-actions-archive-filter.md) | 中文

## 问题

Workspace 浏览器把行操作（置顶、重命名、分叉、归档）硬编码在 `Rows.tsx` 里，重命名对话框归 `WorkspaceBrowser.tsx` 持有；上游 `dsh-v0.2.0-rc.2` 把同样的操作迁到插件注册的插槽占位，把对话框与 toast 迁到 `shell.overlay`，并把已归档会话管理并入浏览器的视图选项。fork 的侧边栏缺归档筛选、停止并归档确认框与第三方操作接缝，已归档会话只能从设置页恢复。

## 决策

**在 fork 的插槽注入体系上移植上游 session-actions 架构。**

- `sidebar.workspaces.session.menu.item` 与 `sidebar.workspaces.session.row.action` 是浏览器注册声明的 root 作用域 list 插槽；出厂行（置顶 100、重命名 200、分叉 300、归档 400）按 `order` 注册，独立包以 `priority` 注册进同一列表实现覆盖。菜单项通过 `menuOpenStateFactory` 拿到所在行的开合状态——工厂把渲染处的 `hookContext` 绑定成每个条目的 `useMenuOpenState` 钩子，使选中动作能关闭所属菜单。
- 重命名对话框、归档确认框与行内 toast 是 `shell.overlay` 占位，背后是插件私有快照存储（`renameRequest`、`archiveRequest`、`rowToast`）；toast 与浏览器共享同一个 view-store 实例，因此它的“显示已归档”动作写入的正是浏览器读取的同一筛选。
- `Menu` 学会组件子行（与数据行同构的 `MenuItemButton`），并在列表层一次性委托点击处理里决定选中后的焦点回落，数据行与组件行同享一条路径。
- 归档在 `ViewOptionsMenu` 暴露三态 `archivedFilter`（`default`/`show`/`only`）；Workspace 目录树分组（`groupBy: 'workspace-tree'`）经 `owningParentFolder` 把 Workspace 挂到最近的已注册祖先下，`usePanelInfo` 在主面板激活时抑制当前行高亮。
- `workspace.archiveSession` 接受 `{ stopActivity }`；失败抛 `WorkspaceArchiveError`，其 `rpcError.code === 'session-active'` 加 `details.activity` 驱动“停止并归档”确认框，而不是静默拒绝。消费方按 `name` 匹配而非 `instanceof`，因为各客户端 bundle 不共享类身份。

## 已考虑的替代方案

- **随筛选上线退役 `ui-settings-unarchive-sessions`。** 被所有者决策否决：设置页作为第二入口保留，上游对齐矩阵继续记 `owned`。
- **照搬上游 `dsh-api-*-controller` 类型包。** 否决：fork 的 `dsh-client-runtime` 门面已承载相同契约，移植改做 import 重映射而非 vendor 类型包。
- **组件行逐个 `onSelect` 做焦点回落。** 否决：列表上的委托处理器一处观察所有行的激活，不会与数据行路径漂移。

## 影响

侧边栏获得归档筛选、撤销/停止并归档 toast 与第三方会话操作接缝；设置页 Archived sessions 作为第二恢复入口保留。早先 [session-unarchive-restore-surface](2026-09-25-session-unarchive-restore-surface.zh.md) 以“没有可挂操作的行”否决了行内取消归档——筛选现在会渲染这些行，该替代方案被取代，而其设置页决定仍然成立。`session-active` 拒绝不再静默：它点名仍在运行的工作并给出停止选项。
