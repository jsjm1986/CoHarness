# Agent Note: 挂起的会话 intent 在同账号续约中存活

Status: implemented

[English](2026-11-08-pending-intents-survive-renewal.md) | 中文

## 问题

`verifiedAccountId` 在整个未验证续约窗口内被吊销（自 `371a539a490` 起为刻意设计：该窗口不拥有任何私有作用域）。但 pending-intent 订阅把*任何*策略变化都当成账号变更，于是每次传输续约——socket 刷新、焦点再验证、SSE 重连——都会经历 `7 → undefined → 7` 并清掉进行中的会话及已输入的草稿，而这正是 `personal-computers` 续约场景所保护的语义。

## 决定

[runtime/src/client/index.ts](../../../../packages/client/runtime/src/client/index.ts) 只在*另一个已验证*身份到达时才清空 pending intents。一次单纯的吊销（`next === undefined`）是未验证窗口而非账号变更：intent 文本是用户自己输入的本地内容，不是拉取的私有数据，因此在再验证挂起期间保持可编辑。真实的账号切换仍然会清空（`7 → undefined → 8`），而 identity fence 的 `onPrincipalChange` 在真实主体变更时会销毁整棵 fiber。

配套的目录修复：远端 workbench 目录只在已验证的多机模式下才是权威（[WorkbenchToolbar.tsx](../../../../packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx)）。单节点界面根本没有 `/account/api` 路由，所以当 `readCatalog` 存在但部署上下文尚未验证 `mode === 'multi'` 时，本地 session 存储就是选择器的完整数据源；把选择器指向不存在的 gateway 会让它永远为空。

## 已考虑的替代方案

**每次吊销都清空。** 否决：这会让续约存活契约无法实现——任何一次瞬时重取都会销毁已输入内容。

**恢复合并前的 `documentIdentityOwned` 门**（fence 存在时跳过 `setVerifiedAccountId(undefined)`）。否决：`371a539a490` 刻意移除它以保证未验证窗口不拥有私有作用域，且 `plugin.client.spec.ts` 已断言续约期间吊销。

**保留目录 `prewarm`。** 否决并回退（`8e493aac7e4`）：为每台已授权计算机预热行分页违反冷计算机契约——未使用的 runtime 必须收到零请求，被动读也不例外。
