# Agent Note: 插件页标注所编辑的运行时范围

Status: implemented

[English](2026-10-10-plugins-page-runtime-scope-label.md) | 中文

## 问题

侧边栏插件页编辑的是浏览器当前挂接的运行时目标——个人空间下的个人账户运行时，或项目空间下的项目共享运行时——每个目标各持有一份独立组装（`harness.plugin_states` 按用户或项目键控）。此前页面在两种 scope 下渲染完全一致：进入项目空间的管理员可能把共享组装误认为个人组装，以为自己私下修改，实际改动全体成员的运行时。

## 决定

账户上下文验证完成后，页面副标题下方以一行说明标明本页编辑的运行时。个人 scope 显示「个人运行时 · 仅影响你的会话」；项目 scope 显示「项目 {name} 的共享运行时 · 影响全部成员」，成员信息缺显示名时退回不带名称的项目措辞。`accountPermissions` 为 `unknown` 时该行不渲染——覆盖尚未验证的窗口期，以及不存在协作上下文、没有 scope 概念的部署。

- [`ProjectUiPolicyRuntime.set`](../../../../packages/client/runtime/src/client/project-policy.ts) 的 details 增加 `projectName`，[`ui-collaboration`](../../../../packages/client/ui-collaboration/src/client/index.ts) 发布项目策略时传入 `scope.projectName`。沿用既有运行时服务——它本就是为「不得 import 协作插件的 UI 功能」准备的中继——不新增服务、不加跨包 import。
- 页面经 inject 面的 `hooks` 分区把该源绑定为 `useScopePolicy`，与模块同步、settings describe 源并列；`projectUiPolicy` 进入插件声明的 `inject` 列表。
- 只读成员无需额外措辞：既有 `manage`/`denied` 门控已经禁用控件，说明行表达的是「这是谁的组装」，而非「查看者能做什么」。

## 备选方案

**个人 scope 下不显示该行。** 放弃：该行要消除的歧义在两个 scope 下都存在——项目成员停在个人页时同样值得一个明确答案。

**直接注入协作客户端。** `ui-collaboration` 的 `CollaborationClient` 私有于其 apply 闭包；为显示一行文字把它放宽成服务，会让一个 UI 插件耦合另一插件的内部。`projectUiPolicy` 本就是为此类中继设计的。

## 影响

验证覆盖 `components.client.spec.tsx`（未验证、个人、具名与不具名项目四种情形）、`manager-store.client.spec.ts`（face 接线）、ui-collaboration 的 `plugin.client.spec.ts`（发布的快照字段）。一个 scope 下安装的 bundle 在另一个 scope 下不可见——这正是说明行现在解释的预期隔离。
