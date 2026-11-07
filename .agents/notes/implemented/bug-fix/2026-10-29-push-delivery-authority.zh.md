# Agent Note: 推送投递保留收件人与尝试归属

Status: implemented

[English](2026-10-29-push-delivery-authority.md) | 中文

## Problem

并行通知回调可以同时领取 pending 投递。发送前已捕获的设备 Token 可能转属另一账户，而已停用账户或失去项目读取权限的账户仍会收到通知。迟到的提供方失败可以覆盖后继尝试，或删除已经属于另一账户的设备。被拒绝的凭据初始化 Promise 还可能阻止配置修复后的恢复。

## Decision

[设备注册与投递准入](../../../../gateway/src/push-notifications.ts)在事务中保留[有效账户](../../../../gateway/src/postgres/account-authority.ts)。领取时重新检查继承的会话可见性、有效项目读取权限、分配电脑权限，以及设备当前的账户、Token 和 provider。个人根会话和子会话要求所有者身份，管理员也不例外，还须匹配根会话的精确 Runtime 分配及该电脑当前的使用授权。另一台获准电脑不能授权该会话；缺失或已移除的运行时分配不具备投递资格。准入保留分配和授权到领取提交为止，早于冲突的撤销提交；网络工作在数据库连接释放后开始。设备注册与账户偏好仍属于整个账户。

现有投递键允许领取 failed 或已过期 pending 记录；sent 和未过期 pending 记录跳过。递增的尝试次数约束结算与无效注册清理。清理还要匹配已捕获的账户、Token 和 provider，从而保留转属后的注册。提供方准备与 HTTP 共用一个配置期限。pending 租期必须大于该期限，并在进程消失后允许恢复。远端接受结果不确定时，重试仍可能造成重复投递。

FCM 只缓存成功的凭据与客户端初始化。初始化被拒绝时只清除该次 Promise，保留任何后继缓存。配置修复后，同一个 sender 可以重试。已确认的提供方接受结果不会因响应 body 释放的次要失败变成失败。

未配置的提供方会报告失败，并保留注册。没有远端接受结果就不能建立 sent 记录。后续回调使用已配置的 sender 时，可以重试同一事件和设备。

[Android 薄壳决策](../feature/2026-08-17-android-remote-web-fcm-notifications.zh.md)继续定义异步追加调度，以及没有 outbox worker 时已记录的崩溃窗口。[JPush provider 选择](../feature/2026-08-18-android-jpush-multi-provider-delivery.zh.md)独立于领取归属。

## Alternatives considered

**重新领取每条 pending 记录。** 这会允许并行发送者重复发送同一完成事件。

**在提供方 HTTP 期间保留账户或设备锁。** 缓慢的提供方会阻止权限撤销并占用数据库容量。准入只保留资格到领取提交为止。

**只按设备 id 删除无效注册。** 旧尝试尚未结束时，设备归属和 Token 值可能已经改变。

## Consequences

部署通过 [Gateway 配置](../../../../gateway/README.zh.md)控制尝试期限和 pending 租期。现有数据库列与设备 API 字段足以承载这些规则。sent 记录提供持久化去重；failed 和过期记录在再次触发通知回调时可以重试。不增加后台重试或远端恰好一次保证。

## Verification

PostgreSQL 屏障验证重复领取、归属转移、资格撤销、电脑权限保留、过期领取和旧尝试结算。本地 HTTP 提供方等待期间，只有一个连接的池仍可使用。可运行的 Gateway HTTP 回放证明完成事件提交后才投递、重复抑制和未完成过滤；本地提供方还验证另一台电脑仍获准时的个人根会话与子会话投递、来源授权撤销、删除、恢复和 Runtime 移除。凭据恢复测试使用合成文件与本地认证替身；真实云端投递需要单独的部署验证。
