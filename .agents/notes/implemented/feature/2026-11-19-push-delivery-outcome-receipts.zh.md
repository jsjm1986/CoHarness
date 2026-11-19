# Agent Note: 设备上报的推送送达结果回执

状态：已实现

[English](2026-11-19-push-delivery-outcome-receipts.md) | 中文

## 问题

`push_deliveries.status = 'sent'` 只记录了运营商受理——JPush 或 FCM HTTP API 确认了请求——从来不是设备送达或用户交互。运维无法区分真正到达手机的通知与被厂商通道在受理后丢弃的通知，用户和管理员也没有任何读取已注册设备或近期投递的界面。

## 决定

在[推送投递权威](../bug-fix/2026-10-29-push-delivery-authority.zh.md)之上扩展设备上报结果，保留既有 claim/fence 模型不变：

- 迁移为 `harness.push_deliveries` 增加 `provider_msg_id`、`delivered_at`、`opened_at`。发送端返回运营商消息 id(JPush `msg_id`、FCM `name`)，`notifyCompleted` 在落 `sent` claim 时一并持久化，用于关联。
- `POST /account/api/push-receipts` 接收 `{provider, token, sessionId, eventSeq, kind}`，`kind` 为 `arrived` 或 `opened`。`recordReceipt` 复核活跃账户，按组织、provider、token、用户解析自有设备，然后给匹配投递打时间戳：`arrived` 写 `delivered_at`;`opened` 写 `opened_at` 并回填 `delivered_at`。同一投递的重复回执幂等；不属该用户或未知目标返回 `missing` → HTTP 404。
- `GET /account/api/push-devices` 列出当前账户的设备及每台设备最近一次投递；`GET /admin/api/push/overview` 返回全组织设备、最近 200 条投递、按状态与 provider 的聚合计数。
- Android 壳在 `CoHarnessPushReceiver` 上报两种信号：`onNotifyMessageArrived` 发 `arrived`,`onNotifyMessageOpened` 在既有 [runtimeId 点击桥](../bug-fix/2026-11-19-android-push-bridge-runtimeid-contract.zh.md)之前发 `opened`。`PushReceiptReporter` 在后台线程携带 WebView `CookieManager` 会话 cookie，向 `BuildConfig.PUSH_GATEWAY_ORIGIN`（由 `DSH_ANDROID_WEB_URL` 注入）发送；畸形 extras、缺失或非数字 `eventSeq`、空 token 一律静默丢弃。
- `NativePushStatusPlugin.getPushStatus()` 通过 `apps/web/src/native-push.ts` 的 `getNativePushStatus()` 向被封装的 web 应用暴露 provider 配置、JPush 同意/初始化、系统通知开关与 JPush registration id。

## 后果

- `sent` 现在精确表示运营商受理；`delivered_at` 与 `opened_at` 是仅有的设备真实信号。投递合法地永远停在 `sent` 而无 `delivered_at`（厂商通道被杀死、设备离线、JPush 未配置）。
- 回执上报是尽力而为且不阻塞：传输失败、缺少会话 cookie 或 WebView 未登录会丢失该回执，但不影响通知展示或点击路由。不加重试/外发队列，与壳的既有异步追加窗口一致。
- 诊断构建（`NATIVE_PUSH_ENABLED=false`）从不上报回执，`getPushStatus` 报告未配置。
- 目前只有 JPush 产生回执；FCM 路径注册设备但未接入原生到达/打开回调，在补齐之前 FCM 投递不会越过 `sent`。

## 备选方案

- **信任运营商服务端回执回调** —— 就送达真实性而言被否：JPush 送达回执需要独立的回调基础设施，且仍无法观察只有设备知道的打开事件。
- **经 web 应用的已认证 fetch 上报** —— 被否：通知到达时 WebView 可能已被杀死或停留在旧页面；只有原生 receiver 保证会运行。
- **回执排队重试** —— 被否：为服务端已幂等的诊断遥测引入持久外发队列不值得；下一条通知的回执会重新观察同一设备状态。

## 验证

- `gateway/tests/server.spec.ts` + `push-notifications-postgres.spec.ts` —— 159/159 通过，覆盖回执幂等、`arrived`/`opened` 时间戳语义、按账户的设备隔离、admin 聚合、异 token 拒绝与未知目标 404。
- `NativePushBridgeTest` 插桩覆盖到达与打开载荷（provider/token/sessionId/eventSeq/kind)，以及畸形 JSON、缺失序号、非数字序号的拒绝。
- `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug` —— BUILD SUCCESSFUL。
