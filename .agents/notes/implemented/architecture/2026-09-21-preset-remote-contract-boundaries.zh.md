# Agent Note：preset remote 面保持类型化错误、turn-boundary 空会话判定与 mount 包装

Status: implemented

[English](2026-09-21-preset-remote-contract-boundaries.md) | 中文

## 问题

上游 `remote.spec` 断言的若干行为是本地 preset remote 有意不具备的：非 `RemoteError` 的原始拒绝直接透传给调用方、空 turn 即算会话已开始、mount 失败按行抛 `RemoteError`。把移植 spec 按上游语义落地会削弱云端宿主依赖的契约；按本地契约落地则需要把分歧一次写明，锁定断言留在 `tests/remote.spec.ts` 与 `tests/mount.spec.ts`。

## 决定

**远端失败只以 `RemoteError` 过线。** `presetRefusal` 把一切非 `RemoteError` 抛出包装为 `RemoteError('gateway/internal', …)`；无关实现失败的类型不越过 Gateway 边界。名册与导出方法同样如此——调用方按 `RemoteError.code` 分支，绝不按内部错误的 `instanceof`。

**空会话判定读 `turnBoundary` 投影，而非消息内容。** 只有 command/plugin 活动事件的会话仍可切换；上游 `hasConversationContent` 按 turn 开始计数。本地投影与切换授权方读的是同一来源，判定不可能与会话模型其余部分相矛盾。

**根缺席的拒绝不点名 preset。** 当不存在可写 preset 根时，`PresetNotWritableError` 携带空 preset id——失败关乎副本能落进哪个根，而非被复制的 preset 本身。

**mount 失败在挂载处包装一次。** `PresetMountError` 是挂载发出的唯一错误；其消息携带展平后的行级诊断（`mountDetail` 渲染 aggregate 与 cause 包装成员并缩进）。上游改为每行一个 `RemoteError`；本地包装让挂载边界保持类型化，同时 `inactiveRows`/`unresolvableRows` 让行名在其中可读。

## 曾考虑的替代方案

**像上游一样透传原始拒绝。** 拒绝：实现错误的类会越过 Gateway 边界，让客户端得到一个随内部实现而变的 `instanceof` 面。`gateway/internal` 包装使一切线上失败落在声明过的码位内。

**把裸 turn 开始算作会话已开始。** 拒绝：command 与 plugin 活动同样开启 turn，一个从未面向模型的会话会被读作对话进行中，失去投影契约下本有的可切换性。

**像上游一样让 mount 失败按行抛出。** 拒绝：调用方将不得不为一个根本不是远端失败的结果检查 `RemoteError`——挂载发生在进程内。单个类型化 `PresetMountError` 让边界如实，展平诊断保留行名。

## 后果

`tests/remote.spec.ts` 断言无关抛出包装为 `gateway/internal`、无根名册抛空 id `PresetNotWritableError`、仅 command/plugin 活动的会话可切换。`tests/mount.spec.ts` 断言 `nested-broken` 组夹具下 `PresetMountError` 携带展平成员行。

名册 API 不含 `includeShippedRoot`、`modeSelectionEnabled`、`authorable` 标志；shipped root 由 `profile-boot` derived patch 承接（见[派生 shipped preset 根](2026-08-29-derived-shipped-preset-root.zh.md)），模式选择属云端产品不在此 remote 暴露的面。

## 验证

`packages/preset/agent-presets`：`pnpm exec vitest run packages/preset/agent-presets` —— 172 测试，含按上述契约写断言的移植 `remote.spec`（24）与 `mount.spec`（53）。
