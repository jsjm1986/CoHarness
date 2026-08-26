# Agent Note：Gateway 持有文档作用域列表

Status: implemented

[English](2026-08-25-gateway-document-scope-loopback-leak.md) | 中文

## 问题

文档管理器的其他作用域列表使用了公开的 `/api` 代理路径。该路径可能到达使用实例回环端口的运行时 HTTP 服务，因此上游重定向或运行时不完整时，浏览器操作可能被导航到 `127.0.0.1:<port>`。运行时端口和私有运行时故障属于主机事实，不能出现在浏览器响应中。

## 决策

配置 PostgreSQL 文档 broker 时，由 Gateway 持有 `POST /api/documents/transfer/list`。该路由限制并解析 JSON 请求体，委托给运行时 Consumer 使用的同一 broker 完成授权和元数据读取，返回禁止缓存的 JSON，并把 broker 故障映射为稳定的嵌套错误对象。broker 读取选定运行时时禁止内部重定向。通用代理还会把回环 `Location` 转换为同源路径，作为其他上游路由的纵深防御。

## 备选方案

**继续让列表请求走通用运行时代理。** 不采用，因为代理没有文档专用响应约定，可能转发内部运行时 authority 或 HTML 导航响应。

**暴露浏览器可见的运行时 URL，再由客户端过滤。** 不采用，因为运行时 authority 是不必要的浏览器能力，客户端既不能阻止导航，也不能保护其他客户端。

**在 Gateway 路由中复制一套授权逻辑。** 不采用，因为它会与现有文档 broker 漂移。公开适配器把已认证的 `UserRow` 交给与运行时适配器相同的 actor 级 broker。

## 结果

即使目标运行时正在启动、不可用或返回重定向，作用域切换仍是页面内的 JSON 操作。运行时回环地址只存在于 Gateway 到运行时的服务端请求中。其他代理重定向不能泄露回环 authority，非回环重定向仍保持上游语义。

## 测试

`gateway/tests/server.spec.ts` 验证公开列表路由不经过代理并且没有 `Location`。`gateway/tests/document-transfer.spec.ts` 验证公开适配器复用项目授权并拒绝内部重定向。`gateway/tests/proxy.spec.ts` 验证回环重定向改写，并保留看起来像回环但实际不是回环的 hostname。

## Related

- [文档作用域 runtime readiness 与安全 Provider projection](2026-08-26-document-scope-runtime-readiness.zh.md) — 负责瞬时 runtime 重试、结构化 readiness 错误和规范 Provider URL projection。
