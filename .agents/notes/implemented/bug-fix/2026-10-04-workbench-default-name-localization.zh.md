# Agent Note: 工作台默认名与副本名在显示层本地化

Status: implemented

[English](2026-10-04-workbench-default-name-localization.md) | 中文

## 问题

`viewport.ts` 和 `workbench-persistence.ts` 构造的工作台行、以及 `WorkbenchToolbar` 的副本名预填，内嵌了中文字面量 `我的工作台` 和 `副本`。英文模式下工具栏触发器、工作台菜单和副本对话框都渲染中文，且持久化目录会把中文默认名存为该行名称。

## 决策

空存储名表示工作台行未命名；显示层渲染本地化的 `defaultWorkbenchName`/`workbenchCopy` 标签。服务原样保留名称——`createWorkbench`/`duplicateWorkbench` 持久化 `name.trim()` 不做语言兜底，目录恢复哨兵存 `name: ''`，`currentWorkbench` 构造的默认行也存 `name: ''`。`WorkbenchToolbar` 在菜单和触发器里把空名映射为 `t('defaultWorkbenchName')`，并用 `workbenchCopy` 模板构造副本预填。旧中文默认名下已持久化的行保留该名称，作为用户数据处理。

## 文件

- `packages/client/ui-workbench/src/client/locales.ts` — 两份字典新增 `defaultWorkbenchName` 与 `workbenchCopy` 键。
- `packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx` — 菜单/触发器标签与副本预填本地化。
- `packages/client/ui-conversation/src/client/viewport.ts` — `currentWorkbench`、`createWorkbench`、`duplicateWorkbench` 使用空名哨兵。
- `packages/client/ui-conversation/src/client/workbench-persistence.ts` — 目录恢复使用空名哨兵。

## 考虑过的替代方案

**创建时持久化本地化名称。** 那会把创建时的语言写进持久数据：中文环境下建的工作台在切换到英文后仍渲染中文，且该字符串与用户手输的名字无法区分。

**把既有的中文默认值迁移为空。** 已存的「我的工作台」无法与用户刻意输入的同名相区分；凭猜测改写用户数据比保留旧字面量更糟，新代码把它当作普通名字处理。

## 后果

英文模式显示 "My workbench"/"… copy"，中文模式渲染文本与此前一致，因此现有中文模式测试钉住的渲染文本不变。持久化名称现在与语言无关：未输入名称创建的工作台按当前语言环境显示，而不是按创建时的语言环境。展示 `SavedWorkbench.name` 的调用方必须套用同样的空名映射；目前工具栏是唯一消费方。
