# Agent Note: 挂起的会话 intent 在同账号续约中存活

Status: implemented

[English](2026-11-08-pending-intents-survive-renewal.md) | 中文

## 问题

`verifiedAccountId` 在整个未验证续约窗口内被吊销（自 `371a539a490` 起为刻意设计：该窗口不拥有任何私有作用域）。但三个策略订阅都把*任何*身份变化当成账号变更（pending-intent 清空、personal-directory 的 account-lifetime 重置、viewport 导航挤兑），第四处以另一种方式杀死同一 pending prepare:`ui-workspace` 把 `sessions.beginNavigation()` 绑进了 prepare 的中止集，续约重放的会话重开挤兑了在途信号——每条路径都会把存活的 intent 翻转为 `unavailable`。每次传输续约——socket 刷新、焦点再验证、SSE 重连——都会经历 `7 → undefined → 7` 并同时命中它们，而这正是 `personal-computers` 续约场景所保护的语义。

## 决定

[runtime/src/client/index.ts](../../../../packages/client/runtime/src/client/index.ts) 只在*另一个已验证*身份到达时才清空 pending intents,[personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) 对其 account lifetime 适用同一规则：两者在单纯吊销（`next === undefined`）期间都保留最后已验证身份，因为那是未验证窗口而非账号变更。intent 文本是用户自己输入的本地内容，不是拉取的私有数据，因此在再验证挂起期间保持可编辑；其 prepare 信号内嵌 `accountLifetime` 的 pending restore 也不会在途中被中止；[ui-conversation 的 viewport](../../../../packages/client/ui-conversation/src/client/viewport.ts) 对导航挤兑适用同一规则：单纯吊销会清空私有持久化作用域，但绝不调用 `sessions.beginNavigation()`，因此挂起输入的 navigation 信号挺过整个窗口。[ui-workspace](../../../../packages/client/ui-workspace/src/client/index.ts) 的 prepare 中止集只保留 `editing`(intent 自己的 controller——真实用户导航时 `hide`/`clear` 仍然取消）加上 fiber lifetime 与调用方信号；`beginNavigation()` 被移除，因为挤兑是视图事实而非 intent 死亡——`commitOpen` 的转移检查已决定 intent 是否仍拥有落点。真实的账号切换仍然会清空（`7 → undefined → 8`），而 identity fence 的 `onPrincipalChange` 在真实主体变更时会销毁整棵 fiber。

配套的目录修复：远端 workbench 目录只在已验证的多机模式下才是权威（[WorkbenchToolbar.tsx](../../../../packages/client/ui-workbench/src/client/components/WorkbenchToolbar.tsx)）。单节点界面根本没有 `/account/api` 路由，所以当 `readCatalog` 存在但部署上下文尚未验证 `mode === 'multi'` 时，本地 session 存储就是选择器的完整数据源；把选择器指向不存在的 gateway 会让它永远为空。

## 已考虑的替代方案

**每次吊销都清空。** 否决：这会让续约存活契约无法实现——任何一次瞬时重取都会销毁已输入内容。

**恢复合并前的 `documentIdentityOwned` 门**（fence 存在时跳过 `setVerifiedAccountId(undefined)`）。否决：`371a539a490` 刻意移除它以保证未验证窗口不拥有私有作用域，且 `plugin.client.spec.ts` 已断言续约期间吊销。

**保留目录 `prewarm`。** 否决并回退（`8e493aac7e4`）：为每台已授权计算机预热行分页违反冷计算机契约——未使用的 runtime 必须收到零请求，被动读也不例外。

## 后果

只要文档仍属同一账号，挂起的 intent 与已输入草稿就能挺过任意次数的传输续约；只有当另一个已验证账号到达、或 fence 销毁整棵 fiber 时才消失。单节点部署上的选择器只读本地 session 存储，`/account/api` 缺失不再会让它永久为空；已验证的多机部署仍以远端目录为准。

## 验证

`personal-computers` 传输续约场景在 `renewEventStreams` 期间保持会话打开，并断言挂起的 intent 及其草稿仍可编辑。`ui-conversation` 的 NodeDraft 定向套件以逐文件 100% 覆盖率验证归属类别、挂起重放与 legacy-copy 迁移。
