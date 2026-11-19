# Agent Note: 经 ntfy distributor 的 UnifiedPush 推送 provider

Status: implemented

[English](2026-11-20-unifiedpush-ntfy-provider.md) | 中文

## 问题

CoHarness 的推送投递必须注册商业推送账号：JPush 需要 AppKey/Master Secret,FCM 依赖 Firebase——而国行设备没有 Google 服务根本不可达。此前不存在一条免费、开源、可自托管的路径能把任务完成通知送到 Android 壳。

## 决策

新增第三个 `PushProvider` —— `unifiedpush`,走 [UnifiedPush](https://unifiedpush.org) 协议、[ntfy](https://ntfy.sh) 作为 distributor，原样复用既有[回执管线](2026-11-19-push-delivery-outcome-receipts.zh.md)与 [runtimeId 点击桥](../bug-fix/2026-11-19-android-push-bridge-runtimeid-contract.zh.md):

- `unifiedpush` provider 存进 device token 列的是 distributor 签发的 endpoint URL——一个 HTTPS 写能力 URL(`https://<ntfy-host>/up<token>`)。`gateway/src/push-notifications.ts` 中的 `UnifiedPushEndpointSender` 向该 URL POST `{title, body, runtimeId, sessionId, eventSeq}` JSON;2xx 即运营商受理，JSON 响应里的 `id` 记入 `provider_msg_id`,HTTP 400 归为 invalid-token 供清理。
- 出站 endpoint 由 `HGW_UP_ENDPOINT_ALLOWLIST` 约束——逗号分隔的主机名白名单（`gateway/src/config.ts` 的 `upEndpointAllowlist`):token 必须能解析为 URL、必须是 `https:`、主机必须精确命中或为白名单域名的子域名，否则在任何网络调用前按 invalid-token 拒绝。sender 永不向任意 URL 发请求；未配置该变量时 provider 保持禁用。
- Android 壳内嵌 `org.unifiedpush.android:connector`(Gradle 强制 `tink-android`，因为 connector 依赖的 JVM `tink` 构件在运行时会冲突）。`CoHarnessPushService` 继承 `PushService` 并监听 `org.unifiedpush.android.connector.PUSH_EVENT`:`onNewEndpoint` 持久化 URL 并以保留事件 `unifiedPushEndpoint` 透传给 web 层；`onMessage` 解析载荷、上报 `arrived` 回执、在 `ai-replies` 渠道发本地通知——其启动 intent 携带与点击桥一致的 session/runtime/provider extras,`opened` 回执在 `handleNotificationIntent` 内、当 `EXTRA_PUSH_PROVIDER` 为 `unifiedpush` 时上报。畸形载荷与缺失/非数字 `eventSeq` 静默丢弃。
- `NativePushStatusPlugin.initializeUnifiedPush` 先 `tryUseCurrentOrDefaultDistributor`（系统选择器需要 Activity 上下文）再 `UnifiedPush.register`;`getPushStatus` 上报已确认的 distributor 与已存 endpoint。`CoHarnessApplication` 在冷启动时若已有确认的 distributor 则静默重新注册。
- `apps/web/src/native-push.ts` 把已存的和事件下发的 endpoint 都以 `provider: 'unifiedpush'` 注册到 `/account/api/push-devices`；旧壳不返回 status 也就不暴露该方法，行为与之前一致。两处"无配置早退"现在都放行支持 status 的壳，让 UnifiedPush 在 FCM/JPush 双缺的设备上也能工作。

## 备选方案

- **WorkManager 轮询 + 本地通知**：零外部依赖，但约 15 分钟粒度且在 MIUI 省电策略下进一步被压制——只配做降级兜底，不算投递路径。
- **壳内嵌前台服务直连 ntfy（不用 distributor)**：省一个 APK，但重复了 ntfy 已有的连接工作、多一条常驻通知栏，且在 MIUI 下照样死——distributor 进程严格更抗杀。
- **直连小米厂商通道**：该机型上真正的杀进程送达，但要注册小米开放平台账号并按 OEM 逐家接 SDK——与"免注册"目标相悖；若将来有账号，JPush 聚合仍是更优的商业路线。

## 验证（红米 K30 Ultra + ntfy F-Droid 1.25.2)

- 插桩测试对真实 distributor 完成注册：ntfy 为 `com.coharness` 建立订阅 `up01yXfjZxSCdN` 并签发 endpoint。
- `curl POST https://ntfy.sh/up01yXfjZxSCdN` → ntfy 转发 `org.unifiedpush.android.connector.MESSAGE` 广播 → connector 解密失败回退明文交 `onMessage` → 约 1.2 秒后 `ai-replies` 渠道弹出「AI 回复完成」通知；点击经 PendingIntent extras 把 `MainActivity` 带到前台。
- `arrived`/`opened` 回执经插桩 sink 实证（`provider: unifiedpush`、endpoint token、数字 `eventSeq`)；畸形 JSON 与缺 runtimeId 均无回执。
- MIUI 硬限制为实测而非推断：未开自启动时 `WakePathChecker` 记录 `Broadcast Reject … callee=com.coharness … action=org.unifiedpush.android.connector.MESSAGE`，投递静默死亡；开启 CoHarness 的 MIUI 自启动开关后，`kill -9` 的进程被广播拉起并在 POST 后约 2 秒发出通知。`am force-stop` 属框架级规则，任何广播都无法送达——所有非厂商通道共有的限制。
- ntfy 自身需要关电池优化与开自启动才能开机存活；其前台服务在运行时维持 WebSocket 长连。

## 影响

- 部署方通过 `HGW_UP_ENDPOINT_ALLOWLIST` 按 ntfy 主机名逐台开启；白名单同时把写能力 URL 约束在可信服务器内。
- 普通进程死亡下的送达取决于 ROM 是否允许跨应用广播唤醒（MIUI 需要用户可见的自启动开关）;force-stop 仍然彻底掐断链路。
- 跑旧版 web bundle 的 WebView 壳无法驱动注册——原生方法已就位，但线上站点的 `setupNativePush` 早于本改动；站点 bundle 随本改动发布后注册自动开始。
