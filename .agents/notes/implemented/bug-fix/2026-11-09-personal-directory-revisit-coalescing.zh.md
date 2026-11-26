# Agent Note: 合并目录重访与恢复重试事件，不再丢弃

Status: implemented

[English](2026-11-09-personal-directory-revisit-coalescing.md) | 中文

## Problem

[personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) 在已有飞行中的操作时丢弃了两类事件。`focus`(`online`/`focus` 处理器）在 `revisit` 被占用时静默返回，`restoreSelection(retry)` 在 `restoreWork` 被占用时静默返回。两处丢弃丢失的是**事件**而不只是重复工作：飞行中的操作是按其启动时的世界状态发出的——在注定失败的恢复 open（仍在竞速离线窗口的 open）期间到达的 `online` 事件不会产生任何恢复后的尝试，恢复的会话 intent 卡片永远停留在 `unavailable`。`personal-navigation-resume` 场景正是演练此路径：离线远端、保留的 intent 草稿、随后 `online`——卡片必须在重试恢复提交后隐藏。

## Decision

每个丢弃点合并为一次延迟执行。`focus` 在重访飞行中时记录 `revisitQueued`，待其 settle 后再跑一次；`restoreSelection` 在 `restoreWork` 期间为 `retry` 到达记录 `retryQueued`，在该飞行 settle 后重入。合并仍把工作量界定为每次排空至多一次额外执行——与 `refresh` 不同，后者对飞行中 `work` 是**共享**的（已在运行的请求结果满足调用方），而事件触发的重访必须在事件之后重读，因为飞行中的结果早于事件所宣布的状态变化。`attempt.signal.aborted` 仍是永久终止：被取代的导航正确地杀死已保存选择的尝试。

主动刷新环境和重试与 `focus`、`online` 共用入口所属的失效处理。它们先清空共享元数据目录，再读取治理状态，因此已就绪的缓存快照不能代替当前可用性查询。调用者等待完整的合并序列，包括较早读取期间请求的后续读取。销毁会取消该序列，阻止排队的刷新获取新工作。其他浏览器标签页保留各自独立的目录所有者。

## Alternatives considered

**并发执行该事件的行程。** 拒绝：并行重访使目录请求翻倍，且与在飞请求的 republish 排序不良。

**让 `refresh` 的 `work` 去重服务该事件。** 拒绝：共享过期的在飞结果正是事件要使其失效的东西；重试必须读取事件之后的世界。

## Consequences

`online`/`focus` 事件在重访飞行中时不再丢失，恢复重试在 open 飞行中到达时总会在其 settle 后运行一次——离线恢复卡片在首个恢复后行程提交，不再滞留。多个事件仍折叠为一次额外执行。

## Verification

`personal-directory.client.spec.ts` 把首个 `ensureSession` open 挂在闸门上，飞行中触发刷新重试，观察排队后的第二次 open 提交已存会话。`personal-navigation-resume.e2e.ts` 覆盖完整浏览器路径：离线保留 intent 草稿、`online`、卡片隐藏、输入落回原会话。

[环境刷新浏览器场景](../../../../apps/web/tests/personal-directory-refresh.e2e.ts) 记录通过实际刷新和重试控件使选中环境变为不可用再恢复的过程，不依赖焦点事件，也不准备 Runtime。目录测试覆盖缓存中的可用性、独立所有者、并发刷新完成及读取未结束时的销毁。
