# Agent Note: Android JPush 多通道通知

Status: implemented

[English](2026-08-18-android-jpush-multi-provider-delivery.md) | 中文

## Problem

目标部署中的 Android 设备并不共用一个可靠的推送通道。现有 Capacitor 薄壳已经支持 FCM，但国内设备还需要 JPush 和可选厂商通道，同时不能生成第二个应用包，也不能把回复内容暴露在未认证的通知界面。

## Decision

Android 薄壳保留 `com.coharness` 应用 id，并把 JPush `6.2.0` 作为基础原生通道。华为、FCM、小米、OPPO、vivo、魅族和荣耀集成为可选 Gradle 依赖，由明确的 `JPUSH_ENABLE_*` 属性控制。华为和 FCM 客户端配置文件只作为构建输入，保留在仓库之外。

Web UI 通过 `/account/api/push-devices` 注册 FCM Token，并通过同一端点携带 `provider: "jpush"` 注册 JPush RegistrationID。原生薄壳只在 Android 通知权限获准后初始化 JPush，并在之后的主进程启动中恢复该授权。PostgreSQL 保存 provider，并按 `(organization_id, provider, token)` 强制唯一；没有 provider 的请求继续按 FCM 处理，以兼容旧客户端。

Gateway 为每个 provider 构造一个 sender。FCM 继续使用现有 HTTP v1 service-account 流程；JPush 使用 REST `/v3/push` 端点，并用 `HGW_JPUSH_APP_KEY` 与 `HGW_JPUSH_MASTER_SECRET` 做 Basic 认证。两个 JPush 变量在配置加载时成对校验。账户 API 拒绝未知 provider，provider 返回无效注册时会删除对应注册。

原生薄壳在没有 Firebase 客户端配置时不会调用 Firebase 注册，因此只使用 JPush 的构建不需要 FCM 凭据。JPush 通知点击只携带会话 id 和事件序号。Receiver 同时把冷启动和热启动 Intent 转给 Capacitor 插件；插件会保留事件，直到 Web listener 打开认证会话。

## Alternatives considered

**所有 Android 构建都用 JPush 替代 FCM。** 否决，因为有 Google Play 服务的设备仍适合 FCM，现有注册也必须继续工作。

**在 Gateway 中直接实现每个国内厂商的 SDK。** 否决，因为 JPush 已经统一了厂商注册与投递，Gateway 只需要一个 provider sender 和一套设备注册表。

**不在设备记录中保存 provider，而是从 Token 推断。** 否决，因为 FCM Token 和 JPush RegistrationID 的生命周期不同，同一账户可以同时存在两者；唯一性与路由必须显式按 provider 区分。

**把回复正文放进通知。** 否决，因为通知内容可能在认证 Web UI 外显示；payload 只保留会话指针。

## Consequences

只使用 JPush 的部署不需要 `google-services.json`；FCM 和华为仍分别需要对应控制台文件。Gateway 主机必须保护 JPush 与 Firebase 服务端凭据，运维人员也只能启用已经配置厂商控制台凭据的通道。现有设备记录必须先应用 provider-aware 的 migration 010，才能使用新的路由键注册和投递。

薄壳仍是远程 Web 包装器，因此普通 Web UI 发布不需要重建 APK。原生推送通道、权限、包名、图标或点击处理变化仍需要 Capacitor 同步和重新构建。通知仍是创建者范围内的会话提示，不复制第二份 transcript。

## Verification

Gateway 类型检查以及配置、HTTP、sender 和投递聚焦测试通过。使用仓库 Gradle wrapper 和 OpenJDK 21 执行 Android `:app:assembleDebug` 通过，构建会产生上游 JPush D8 stack-map 警告和原生库 strip 警告，但成功生成 `com.coharness` APK。真实设备投递仍需要部署凭据以及至少一个已注册的 JPush 或厂商应用。
