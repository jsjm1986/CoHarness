# Agent Note: Document scope runtime readiness and safe provider projections

Status: implemented

[English](2026-08-26-document-scope-runtime-readiness.md) | 中文

## Problem

文档管理器的元数据请求可能在个人或项目 runtime 尚未启动、正在重启或未通过 readiness 时到达。Gateway 通用代理此前返回非结构化的 `instance-starting` 错误，浏览器随后把它转换为 `Document operation failed.`。runtime Provider profile 也可能保留非规范的嵌入式 base URL，使本来有效的项目在文档路由可用前被 runtime policy loader 拒绝。

## Decision

Gateway 代理的 readiness 响应使用结构化的 `INSTANCE_STARTING` 和 `INSTANCE_UNREACHABLE` 错误码，同时保留供 API 消费方使用的 `Retry-After`。公开作用域列表 broker 会把未分类故障映射为结构化且可重试的 `DOCUMENT_TRANSFER_UNAVAILABLE` 响应。文档客户端只对幂等的元数据读取（当前作用域列表、其他作用域列表、目录列表、汇总和历史）执行两次重试，并遵守有界服务端延迟；不会自动重放上传或复制写操作。Documents 管理器把 readiness 错误码映射为本地化的作用域提示，不再显示泛化操作错误。

PostgreSQL model-policy projection 在写入 runtime policy JSON 前，会把 Provider profile 中的 `baseURL` 规范为 Provider 保存的 URL。这样带尾部斜杠的历史设置仍能通过 runtime 校验，同时不改变已保存的凭据或路由选择。

## Alternatives considered

**重试所有文档请求。** 否决：上传会话和复制操作都是写入；响应不明确时重放可能产生重复持久化工作。

**让浏览器等待每一个 runtime 代理请求。** 否决：冷 runtime 可能占满整个 readiness 窗口并阻塞无关页面导航；元数据读取可以在已有等待响应之外执行有界重试。

**放宽 runtime Provider URL 校验。** 否决：Provider URL 与嵌入式 profile URL 必须描述同一路由；规范化 projection 可以兼容历史格式并保留该不变量。

## Consequences

只要 runtime 在重试窗口内完成 readiness，冷 runtime 的文档视图就能自动恢复，无需手动刷新。持续启动失败会显示作用域专属的本地化提示，写操作不会被重放。runtime policy 文件继续满足严格 URL 相等校验，既有数据库路由和凭据不变。

## Verification

Client 测试覆盖结构化 readiness 错误、`Retry-After` 重试、重试耗尽和 Documents 管理器本地化提示。Gateway proxy 测试覆盖结构化 API readiness 响应。PostgreSQL 集成覆盖写入带尾部斜杠的历史 profile，并验证 runtime policy projection 使用规范 Provider URL。

## Related

- [Gateway 持有文档作用域列表](2026-08-25-gateway-document-scope-loopback-leak.zh.md) — 负责公开 Gateway 路由和 runtime authority 隔离。
- [Gateway model governance live policy reload](../feature/2026-08-14-gateway-model-governance-live-policy-reload.zh.md) — 负责组织策略 projection 和 runtime 热加载语义。
