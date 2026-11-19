# Agent Note: Android 推送桥要求 intent 携带 runtimeId

Status: implemented

[English](2026-11-19-android-push-bridge-runtimeid-contract.md) | 中文

## Problem

`NativePushBridgeTest` 在 `android / native bridge` CI lane 上以三种签名失败——真实 Activity 路径返回空 `observed`、`expected:<notificationAction> but was:<null>`、以及 `listener.payload` 上的 `NullPointerException`。三者同根：插桩代码构造的启动 intent 只带 `coharness.sessionId`（和 `coharness.eventSeq`)，没有 `coharness.runtimeId`，而 `NativePushStatusPlugin.handleNotificationIntent` 会丢弃 runtimeId 为 null 的 intent。该 lane 不在 PR 上运行——仅 `workflow_dispatch` 触发——所以陈旧测试一直未被发现，直到一次手动 audit 暴露。

## Decision

生产契约要求 runtimeId，测试现已对齐：`CoHarnessPushReceiver` 只会发出带 sessionId + UUID 校验 runtimeId 的 intent,web 侧（`apps/web/src/native-push.ts` 的 `openNotificationSession`）也会拒绝 runtimeId 不匹配 UUID 模式的负载。`NativePushBridgeTest` 中每个 intent 现在都携带 runtimeId,observed 负载在 sessionId、eventSeq 之外同时断言 runtimeId,cold-start 测试还验证投递后 runtimeId extra 被消费移除。`handleNotificationIntent` 另外拒收存在但为空的 runtimeId——此前只检查 null，空串会以空字段投递；守卫现在与 sessionId 对称。

## Alternatives considered

- **放宽插件容忍缺失 runtimeId**：否决——receiver、web 监听器与会话路由键（`dsh.sessions.current.v2.{runtimeId}`）都把 runtimeId 当必需；容忍 null 的插件会投递 web 侧立刻丢弃的负载，掩盖配置错误。
- **只改测试**：否决，因空 runtimeId 缺口——空串 extra 属于插件应丢弃而非转发的畸形输入；对称守卫只需一个条件。

## Consequences

桥 lane 的三个插桩测试现在端到端证明真实契约，而非不可能的 intent 形态。携带空 runtimeId 的畸形 intent 不再通知监听器。runtimeId 格式本身仍由上游强制（receiver 的 UUID 检查、web 的 UUID 检查）——插件刻意保留较轻的非空守卫而非复制正则。

## Verification

- `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` —— BUILD SUCCESSFUL。
- 本分支 `android / native bridge` CI lane(`workflow_dispatch suite=android-audit`)——三个 `NativePushBridgeTest` 用例对真实 Capacitor 监听器全部通过。
