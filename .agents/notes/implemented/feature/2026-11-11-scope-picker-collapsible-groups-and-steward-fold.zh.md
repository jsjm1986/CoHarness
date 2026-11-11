# Agent Note: 空间选择器分组折叠与多机维护空间收敛

Status: implemented

[English](2026-11-11-scope-picker-collapsible-groups-and-steward-fold.md) | 中文

## Problem

空间选择器（`ScopeControl`）把每个已授权目的地平铺为四个分组（收藏、最近、个人空间、项目空间）下的行。生产部署中项目分组有 16 行，其中三个是独立的维护空间——每台已接入电脑一个，名为 `维护中枢·<node>`。列表密集，维护三胞胎重复相同前缀，且除了搜索没有任何缩短页面的手段。用户选定的方向是保守路线：保留现有分组语义与授权模型，增加折叠能力，并在视觉上收敛按电脑的维护行。

## Decision

分组保持 `spaceDestinations()` 与 favorites/recent/personal/projects 分桶的既有产出不变。`space-destinations.ts` 新增两个纯展示辅助函数描述行布局：`spaceRowEntries(items, flat)` 把一组目的地映射为 `SpaceRowEntry` 行，当组内存在两个及以上 steward 目的地时，在首个 steward 的原位置折叠为一个 `steward` 条目；`flat` 跳过折叠，使激活的搜索查询仍可按每台电脑的身份匹配并选中。`stewardSpaceBase(destinations)` 推导折叠行名称：所有成员去掉 `·<nodeName>` 后缀后一致时取该基名，否则回退到首个名称的 `·` 前缀。

折叠刻意只做在展示层：[Per-node steward projects](../architecture/2026-11-07-per-node-steward-projects.zh.md) 保持每台电脑的维护空间是独立项目，此处不在模型层做任何合并。

`ScopeControl` 用两个组件内 `ReadonlySet<string>` 状态持有展开状态——`closedGroups`（按分组 id）与 `openStewards`（按所属分组 id，每组至多一个折叠）。分组头是真 `<button>`，带 `aria-expanded` 与旋转箭头；折叠维护行是 `.pageRow` 按钮，含 steward 盾牌图标、共享基名、本地化的 `{count} 台电脑` 电脑行与 `aria-expanded`；展开后在缩进的 `.stewardChildren` 块内渲染未改动的目的地行。选择、切换中禁用与精确 runtime target 均未改动——折叠不产生任何虚构目的地。使用过的 steward 空间会被提升进「最近使用」（或被搜索平铺命中）成为单行，因此 `stewardChildName` 在所有 steward 行（而非仅折叠子行）剥去 `·<node>` 后缀——电脑名已由副行展示。

行采用两行双槽位语法（`destinationLabel`）：名称行右端是暗色 `scopeAccess` 访问标记（非 steward 授权的 `只读`/`管理`），电脑行（`destinationComputer`）右端是运行状态标签。静息状态——`待启动`（stopped）、`启动中`、`准备中`——渲染为 `Tag` `quiet` 纯文本无填充；只有可达性退化（`离线`、`维护中`、`待确认`）保留 warning/danger 胶囊，静息列表不再呈现成一面警告墙。steward 盾牌头像已承载维护身份，因此 steward 行与折叠行不再渲染 `维护` 标记。

## Alternatives considered

**合并行内电脑药丸（方案 A）。** 三行合一但引入行内第二选择控件与新组件；对于密度问题属于过度机制，拒绝。

**按电脑重新分组（方案 C）。** 与工作区树的心智模型一致，但会替换页面其余部分（hero、管理 tab、权限标记）所依赖的 personal/projects 语义；这是模型改动而非展示改动，拒绝。

**持久化展开状态。** `space-navigation-preferences.ts` 刻意只存收藏与最近 runtime 身份；会话内折叠是瞬态 UI 状态，按数据存取阶梯留在组件内。

**在 `spaceDestinations()` 内折叠。** 拒绝：该派生同时服务搜索过滤、当前空间识别与 rail 菜单——在那里折叠会让过滤丢掉真实身份并混淆 `aria-current`；仅在展示层折叠保证各消费方如实。

## Consequences

含 N≥2 个 steward 目的地的分组渲染 1 行折叠而非 N 行；展开后各行原样呈现。搜索（`flat`）逐个渲染 steward，按电脑的查询永远能到达其目的地。分组头获得可访问名（`label + count`），与宽松测试正则冲突——四处 `/个人空间/` 查询收紧为精确匹配，无行为断言变化。展开状态随重挂载重置，与选择器重开即回根级的惯例一致。Rail 菜单（`wide: false`）保持原有平铺渲染；折叠仅作用于页面列表。

## Testing

`space-destinations.client.spec.ts` 覆盖折叠定位、单 steward 直通、flat 旁路与基名推导（含名称不一致）。`components.client.spec.tsx` 驱动真实组件：折叠态隐藏按电脑行、展开后以精确 runtime target 选中 steward 目的地、激活查询展平折叠、分组头切换 `aria-expanded` 并隐藏行。`scope-control-styles.client.spec.ts` 固定按钮重置、箭头旋转、焦点环、子级缩进与双槽位行契约（`scopeNameLine`/`scopeAccess`/`destinationComputer`/`computerName`/`stateTag`）。
