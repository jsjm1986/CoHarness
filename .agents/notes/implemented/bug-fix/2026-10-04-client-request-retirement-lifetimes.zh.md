# Agent Note: 区分客户端请求退役与传输完成

Status: implemented

[English](2026-10-04-client-request-retirement-lifetimes.md) | 中文

## 问题

客户端状态所有者需要拒绝陈旧发布，同时继续负责未完成的传输。被取代的读取可能在变更或权限撤销后才完成，忽略取消的传输也可能在其发布 slot 退役后仍然待完成。资源释放还必须区分读取与已经进入传输的写入。

## 决策

发布资格与完成责任是两件不同的事。`AccountPreferencesMirror` 和 `ProjectModelsBridge` 会在延迟传输准入前安装当前读取。它们保留被取消或取代的传输，直到传输实际完成；每次异步 dispose（资源释放）调用都会等待这些保留的工作。

账户镜像把 revision 相等或更高的写入响应立即接受为 ready，退役旧请求 slot，并且绝不降低已持有的 revision。

账户 scope 绑定会启动共享的首次读取。明确标记为首次连接的 reset 共享该请求或接受其 ready 结果；没有可用结果时会重试。后续或未标记的 reset、窗口获得焦点以及文档可见通知都会强制发起新读取。账户请求已经属于经过认证的浏览器文档，因此首次 Runtime 握手不代表账户偏好出现了更新的 revision。独立的 Host 设置镜像仍保留首连 reset 读取，以关闭其流订阅间隙。

陈旧项目 GET 的调用方优先等待尚未完成的后继请求，其次使用已持有的完整数据；两者都没有时直接拒绝，不发起新的 GET。当前完整 GET 可以在 revision 相等时刷新权限。revision 相等或更低的部分响应与变更回显不能恢复已撤销的可写策略。

`ProjectModelsBridge` 不给已进入项目传输的写入附加随桥接器资源释放而取消的信号，调用方因此仍能收到真实回执。读取、凭据描述请求与发现请求使用生命周期取消信号，并在传输前立即调用 `requireLive`。兼容 update/replace 调用在读取命名空间后再次检查存活状态。已释放的所有者不发布状态，也不触发后续刷新。

协作上下文加载只合并非强制调用。变更后的强制刷新会取代并取消旧的上下文读取，陈旧请求的成功或失败都不会发布。上下文请求 slot 在延迟传输执行或通知订阅者之前赋值。对话详情的强制刷新仍保留合并后的尾随读取策略。

[网页搜索设置卡](../../../../packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts)只在详细页首次可见后负责凭据状态查询。摘要从设置派生，不描述凭据；重复激活共享当前读取。凭据引用未变的设置投影不会使凭据元数据失效。选中引用变更、凭据事件、写入完成或连接重置都会启动新读取，并拒绝旧请求的成功或失败，即使引用相同。重置会清除前一目标的状态提示：共享旧请求可能保留陈旧的凭据或写权限信息。未知或查询失败的状态与未配置密钥保持区别；重新打开页面会重试失败查询。销毁时取消读取，不再发布状态或发送后续请求，并等待已接纳的保存，不取消凭据写入回执。

独立的 [Host 设置镜像](../architecture/2026-08-17-settings-describe-mirror.zh.md)决策负责读取派生与启动预算。[账户偏好冲突重试](2026-10-03-account-preferences-conflict-retry.zh.md)负责 revision 栅栏冲突后的串行重试，[项目设置管理](../feature/2026-08-28-project-scoped-settings-management.zh.md)负责项目管理与凭据权限。

## 考虑过的替代方案

**用同一个当前 slot 管理发布与完成。** slot 退役时会失去对未完成传输的责任，旧工作仍在运行时资源释放就可能已经结束。

**把取消视为完全停稳。** 传输载体可能忽略取消信号；只有实际完成才能确认工作已经结束。

**在首次连接 reset 时替换账户读取。** 替换待完成的认证读取，或重新获取其 ready 结果，并不能确认偏好 revision 更新，只会增加工作。明确的新鲜度信号仍强制触发读取。

**资源释放时取消所有请求。** 取消已进入传输的写入可能丢失真实回执，即使变更已经提交。

**把变更回显作为新鲜权限依据。** 相等或更低的 revision 不能证明授权是新鲜的，也不能恢复已撤销的可写策略。

**插件注册时读取凭据状态，或在重置后复用旧状态。** 摘要无需凭据元数据，重置则会改变目标或权限。延后首次读取可以移除未使用的工作，保留显式失效可以保障权限新鲜度。

## 后果

清理可能需要等待忽略取消的传输载体。陈旧工作不能发布，已进入传输的写入保留其回执，直接调用兼容接口也不能在资源释放后发起新的传输。

## 验证

[账户规格](../../../../packages/client/ui-settings/tests/account-scope.client.spec.ts)、[项目规格](../../../../packages/client/ui-settings-models/tests/project-store.client.spec.ts)与[上下文规格](../../../../packages/client/ui-collaboration/tests/collaboration-client.client.spec.ts)约束请求责任、revision 与权限发布、资源释放时的请求准入，以及上下文与详情各自的刷新策略。

[账户 reset 规格](../../../../packages/client/ui-settings/tests/account-reset.client.spec.ts)通过设置插件覆盖待完成和已 ready 的首次读取、后续 reset 与文档失效，以及资源释放。[组装后的账户启动场景](../../../../apps/web/tests/account-preferences-startup.e2e.ts)让已准入的账户响应跨越真实首次握手，并记录采用后的外观偏好，不发起模型请求。

[网页搜索生命周期规格](../../../../packages/client/ui-settings-plugins/tests/web-search-lifecycle.client.spec.ts)覆盖延后激活、三个引用未变的 scope 投影、旧读取尚未完成时的失效，以及带有未完成读写的销毁。未打开页面时零读取的断言在隔离负控中拒绝原版主动查询控制器。[组装后的插件设置场景](../../../../apps/web/tests/plugin-config.e2e.ts)通过真实浏览器组装与暂缓返回的 RPC 响应，记录查询中、状态不可用及恢复后的可见状态，不发起模型请求。
