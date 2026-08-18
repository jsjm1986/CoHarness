# Agent Note: Android remote Web shell and FCM completion notifications

Status: implemented

[English](2026-08-17-android-remote-web-fcm-notifications.md) | 中文

## Problem

Web UI 需要一条简单的 Android 安装路径，并在 AI 回复完成后向手机发送通知。如果每次 Web UI 调整都重建 APK，薄壳的运维成本会很高；如果把完整回复放进移动通知，未认证的系统通知界面可能暴露会话内容。

## Decision

Android 应用是一个 Capacitor 薄壳，其 `server.url` 指向已部署的 HTTPS Web UI。薄壳只包含原生工程和推送能力；普通 Web UI 发布留在服务器端，不需要重建 APK。新增原生插件、权限、应用 id、图标或通知处理行为时，才需要执行 `cap sync` 并重新构建。

这个薄壳保持为私有工作区应用，而不是 npm 发布成员。根工作区仍包含它以解析依赖并运行本地命令，但 release discovery 和 npm baseline 打包会排除 `apps/android-shell`。

Web UI 在已认证用户授予通知权限后注册 Android FCM Token，并通过 `/account/api/push-devices` 保存。PostgreSQL 记录企业、用户、Token、平台和设备元数据。同一企业内的 Token 唯一，删除操作要求当前认证用户就是设备所有者。Firebase service-account JSON 只放在 Gateway 主机上，绝不提交仓库或发送给 Web 客户端。

Gateway 只通知会话创建者的已注册设备。会话追加返回 `inserted` 且追加事件包含 `turn/end` 与 `data.reason.kind === 'completed'` 时，才异步安排通知；重复追加和非 completed 结束不会再次安排通知。通知 payload 只包含会话 id 和事件序号，因此应用会打开已有的认证 Web UI，而不会把回复文本放入通知。

`push_deliveries` 为每个企业、会话、事件序号和设备记录一条投递键。已发送记录不会再次 claim；FCM 指示 Token 已注销时会删除该 Token。首版在持久化成功后异步发送并记录失败，不增加后台 outbox worker，因此进程可能在追加成功与发送开始之间退出而丢失通知，但不会丢失会话。

## Alternatives considered

**把完整聊天 UI 重写为原生 Android 应用。** 否决，因为这会复制 Web 客户端，并让每次 UI 调整都变成移动端发布。

**把本地 Web 构建产物打进 APK。** 否决，因为每次 Web 发布都需要新的 APK，服务器修复也不能立即到达薄壳。

**让手机轮询 Gateway。** 否决，因为会消耗电量并需要前台或周期性后台调度；FCM 已提供适合该场景的投递通道。

**把 assistant 回复放入通知。** 否决，因为通知可能在认证应用外直接显示，回复也可能包含敏感项目数据。

**首版建设持久化通知 outbox worker。** 暂缓，因为追加路径已有投递幂等性，简单部署不需要额外 worker 进程；崩溃窗口已明确记录，后续再决定可靠性增强方案。

## Consequences

Android 包保持小且稳定，Web UI 发布可以独立进行。用户必须授予 Android 通知权限，Gateway 部署还必须提供 Firebase Android 应用注册信息和仅所有者可读的 service-account 文件。通知按创建者归属，而不是广播给所有项目成员；通知只是打开权威会话历史的提示。

## Verification

Gateway 单元测试覆盖 FCM 请求字段、Token 注册与所有权检查、投递幂等、无效 Token 删除、配置读取、HTTP 认证和 completed 事件筛选。配置 `HGW_TEST_DATABASE_URL` 后，PostgreSQL 集成测试会断言 migration 008 及两张推送表。Android 薄壳 fallback 构建和 Capacitor 工程生成不需要 Firebase 凭据；正式组装还需要部署方的 `google-services.json` 以及 Java/Android SDK 工具链。
