# Agent Note: 空间控件改为常驻于脚注列的空间中枢

Status: implemented
Archived: 2026-10-15

[English](2026-10-13-scope-hub-sidebar-takeover.md) | 中文

## Problem

空间表面此前按一次性选择器设计：切换、新建项目、成员管理、项目设置与新对话可见性全部以扁平条目出现在同一列表中。常驻操作——主题策略、邀请、成员查看、可见性暂存——与会触发页面重载的行竞争同一表面，因此该表面无法超过选择器所需的高度。卡片内嵌抽屉还把卡片皮肤封顶在 `min(340px, 48vh)`，恰好压缩了最需要空间的操作。

## Decision

宽侧栏面板成为**空间中枢**：仍是由 `Menu` 持有行为的文档流内嵌面板，但以透明方式渲染在脚注列上，使各区块读起来是侧栏自身的表面而非内嵌卡片。

- 面板的头部区域承载中枢：返回钮与空间计数、一张当前空间卡（28px 身份磁贴、名称、模式/状态元信息，以及当注入 `loadProjectConfiguration`/`setProjectThemePolicy` 且当前项目在列表中时的设置钮）、一行在 `getInvitationCount` 报告待处理时切换为警告族的邀请入口，以及既有的项目搜索框。
- 新对话可见性离开条目列表，成为当前空间卡内由两个 `radio` 按钮组成的 `radiogroup`。轨道镜像会话头的分段控件：`interactive-bg-hover` 轨道、通过 `--dsh-vis-index` 滑动的 `::before` 浮起 pill、`radius-card`/`radius-control` 圆角。选中某值只暂存设置而不解散面板——暂存偏好不是一次选择。
- 宽版的置顶页脚只保留 `project:create`；成员与设置入口移入头部区块。折叠轨道与紧凑路径不变：portalled 浮层菜单仍携带可见性条目与完整页脚集合。
- `.scopeSheet` 去掉卡片修饰——`--dsw-menu-surface-fill: transparent`、`box-shadow: none`、`border-radius: 0`——高度上限改为 `min(560px, calc(100vh - 150px))`，使列表滚动时触发器与"设置"行始终可达。

`Menu` 仍持有选中、键盘导航、搜索过滤、外点/Escape 关闭与焦点归还；中枢不新增任何行或解散逻辑。

相关：[卡片内嵌抽屉](2026-10-13-scope-switcher-in-card-drawer.zh.md)持有本中枢复用的文档流内嵌面板机制；[宽度自适应面板菜单](2026-10-03-scope-control-panel-menu.zh.md)仍描述折叠轨道路径的测宽浮层列表。

## Alternatives considered

**在侧栏旁滑出二级列。** 设计评审否决：它需要新的宿主列并复制脚注列的修饰；接管方案在既有槽位内提供了同样的常驻表面。

**居中命令面板或网格面板。** 否决：二者都是一次性切换的模态表面；会把常驻的设置、成员与邀请入口再压进一层，并放弃 `Menu` 的行为契约。

**可见性继续作为菜单项。** 对宽版中枢否决：以 `menuitem` 呈现的暂存设置暗示一个执行后即关闭表面的动作；`radiogroup` 表达真实语义，且变更时不会解散中枢。

## Consequences

- 宽版面板不再呈现为卡片：其表面透明，各区块自带修饰。渲染到面板头部的任何内容都必须自带填充/细线，或继承侧栏底色。
- `.scopeField`/`.scopeSheet` 的双类选择器仍是硬性要求。
- 可见性的 `menuitem` id 只存在于折叠轨道路径；测试不得在宽版中查询它们（改用 `radio` 角色）。
- `currentMeta` 兼作状态行：`scopeBusy`/`scopeError` 状态出现在当前空间卡内，触发器自身的忙碌/错误处理不变。

## Testing

`components.client.spec.tsx` 断言中枢表面——radiogroup 暂存且不解散、返回钮、带徽标的警告邀请行、打开 `ProjectSettingsModal` 的设置钮——以及不变的行/选中行为。`scope-control-styles.client.spec.ts` 以词法锁定接管皮肤（透明填充、无阴影、`order: -1`、`position: static`、高度上限）与中枢修饰（卡片填充/细线、分段轨道、滑动 pill、警告行）。聚焦套件通过（5 个文件 75 项测试），`tsc -b packages/client/ui-collaboration/tsconfig.json` 干净。基于真实 `Menu`/`MenuSurface`/主题/`ScopeControl` 样式表构建的 Chromium 渲染验证了 rw 带待处理与 ro 两种表面。
