# Agent Note: 区分客户端请求退役与传输完成

Status: implemented

[English](2026-10-04-client-request-retirement-lifetimes.md) | 中文

## 问题

客户端状态所有者需要拒绝陈旧发布，同时继续负责未完成的传输。被取代的读取可能在变更或权限撤销后才完成，忽略取消的传输也可能在其发布 slot 退役后仍然待完成。资源释放还必须区分读取与已经进入传输的写入。

## 决策

发布资格与完成责任是两件不同的事。`AccountPreferencesMirror` 和 `ProjectModelsBridge` 会在延迟传输准入前安装当前读取。它们保留被取消或取代的传输，直到传输实际完成；每次异步 dispose（资源释放）调用都会等待这些保留的工作。

账户镜像把 revision 相等或更高的写入响应立即接受为 ready，退役旧请求 slot，并且绝不降低已持有的 revision。

陈旧项目 GET 的调用方优先等待尚未完成的后继请求，其次使用已持有的完整数据；两者都没有时直接拒绝，不发起新的 GET。当前完整 GET 可以在 revision 相等时刷新权限。revision 相等或更低的部分响应与变更回显不能恢复已撤销的可写策略。

`ProjectModelsBridge` 不给已进入项目传输的写入附加随桥接器资源释放而取消的信号，调用方因此仍能收到真实回执。读取、凭据描述请求与发现请求使用生命周期取消信号，并在传输前立即调用 `requireLive`。兼容 update/replace 调用在读取命名空间后再次检查存活状态。已释放的所有者不发布状态，也不触发后续刷新。

协作上下文加载只合并非强制调用。变更后的强制刷新会取代并取消旧的上下文读取，陈旧请求的成功或失败都不会发布。上下文请求 slot 在延迟传输执行或通知订阅者之前赋值。对话详情的强制刷新仍保留合并后的尾随读取策略。

独立的 [Host 设置镜像](../architecture/2026-08-17-settings-describe-mirror.zh.md)决策负责读取派生与启动预算。[账户偏好冲突重试](2026-10-03-account-preferences-conflict-retry.zh.md)负责 revision 栅栏冲突后的串行重试，[项目设置管理](../feature/2026-08-28-project-scoped-settings-management.zh.md)负责项目管理与凭据权限。

## 考虑过的替代方案

**用同一个当前 slot 管理发布与完成。** slot 退役时会失去对未完成传输的责任，旧工作仍在运行时资源释放就可能已经结束。

**把取消视为完全停稳。** 传输载体可能忽略取消信号；只有实际完成才能确认工作已经结束。

**资源释放时取消所有请求。** 取消已进入传输的写入可能丢失真实回执，即使变更已经提交。

**把变更回显作为新鲜权限依据。** 相等或更低的 revision 不能证明授权是新鲜的，也不能恢复已撤销的可写策略。

## 后果

清理可能需要等待忽略取消的传输载体。陈旧工作不能发布，已进入传输的写入保留其回执，直接调用兼容接口也不能在资源释放后发起新的传输。

## 验证

[账户规格](../../../../packages/client/ui-settings/tests/account-scope.client.spec.ts)、[项目规格](../../../../packages/client/ui-settings-models/tests/project-store.client.spec.ts)与[上下文规格](../../../../packages/client/ui-collaboration/tests/collaboration-client.client.spec.ts)约束请求责任、revision 与权限发布、资源释放时的请求准入，以及上下文与详情各自的刷新策略。
