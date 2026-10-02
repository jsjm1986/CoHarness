# Agent Note：分组模糊模型选择器与共享 popup-select 分组

状态：已实现

[English](2026-10-02-grouped-fuzzy-model-picker.md) | 中文

## 问题

composer 模型座与 `/model` 指令弹层各自渲染扁平的字母序列表。长目录无法扫读（无 provider 分组、无搜索），指令弹层无法标记当前选中项或排序模糊命中，进行中的选择与已落定的选择看起来没有区别。共享选择器还在每次渲染时重置 `itemRefs.current = []`——被丢弃的并发渲染会把数组清空，而已提交的行仍持有活引用，导致根面板上的方向键遍历停摆。

## 决策

`ModelSelect` 按 `provider-order.ts` 的排序渲染 `MenuGroup` 分组，组内用 `rankByName` 对修剪后的查询词排序，并仅当模型行超过四行时显示搜索框。指令弹层契约新增 `group`、`badge`、`active` 与 `searchMode: 'fuzzy-label'`；`option-groups.ts` 持有分组排序与组内模糊过滤；`PopupSelectView` 渲染同一套 `MenuGroup` 标题，其 `data-stuck` 延迟着色来自 `observeStickyMenuGroups`（IntersectionObserver，不做布局读取）。选择在 Host 写入落定前保持 `pending`：触发器与行显示 `StateDot`，被拒绝的选择保留原路由与目录。

`Input` 转发 ref，`CommandUiRuntime` 新增 `dismiss(name)`，`/model` 传入本地化的 `searchLabels`，两个选择器读到同一套查询文案。行跟踪改用 `isConnected` 过滤代替渲染期重置，被放弃的渲染不会再弄丢焦点映射。

## 已考虑的替代方案

**保留扁平列表、只加搜索框。** 否决：provider 分组才是让五十模型目录可导航的部分；`/model` 弹层与座菜单还必须共享同一分组顺序，否则两个入口教出两套布局。

**用 project reference 给 `apiProxy` 活性探针定型。** 否决：`apiproxy` 与 `api/remotes` 已消费 `cordis-host-runner` 的 `./types` 面，反向引用会闭合 `tsc -b` 引用环。查找改走 `Context.get` 的无类型名重载并在调用点收窄。

## 后果

- `PopupSelectContract` 的 option 可携带 `group`/`badge`/`active`；`searchMode` `'fuzzy-label'` 在各组内排序并丢弃空标题。
- `ModelDirectoryState.pending` 表示进行中的选择；在其清空前消费方不得把 `current` 当作已更新。
- 粘性标题填充色经 `--dsw-menu-group-stuck-fill` token 在两种色板下解析。
- inspect-registry 的 spec 通过 `ctx.get('apiProxy' as string)` 挂载 apiProxy 替身。
