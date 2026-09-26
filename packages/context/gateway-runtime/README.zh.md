# @deepseek-ai/dsh-gateway-runtime

[English](README.md) | 中文

供 Gateway 启动的 Harness 运行时使用的认证请求上下文和私有 loopback 传输。启动凭据将进程绑定到一个组织、一个个人或项目运行时身份，以及用于验证短期浏览器 principal 的 Gateway 密钥。

## 概述

使用 `dsh-gateway-runtime` 获得 Gateway 启动的 Harness 运行时的已认证请求上下文与私有 loopback 传输。启动凭据把进程绑定到一个组织与一个个人或项目运行时身份，并为其他协作包验证短生命周期浏览器主体。


## 运行时约定

- 启动凭据必须且只能从 `DSH_GATEWAY_CREDENTIAL_FD` 或 `DSH_GATEWAY_CREDENTIAL_FILE` 之一读取。它包含仅限 loopback 的 Gateway origin、运行时 bearer token、运行时 generation、组织和 Ed25519 公钥。
- `connection/request` 监听器要求 `x-dsh-gateway-principal`，验证其签名、有效期、组织、scope、运行时身份和 generation，再通过请求局部的 `current()` / `requireCurrent()` 暴露它。
- `interactive()` 只在认证 HTTP 操作仍活动时暴露该主体。`current()` 标识起始认证分发，并可以沿异步上下文传递；它不会向脱离请求的工作授予交互权限。
- `request()` 只接受凭据 loopback origin 上的绝对 `/internal/runtime/` 路径，加入私有 bearer token，并且只在调用方明确要求时转发浏览器 principal。
- 私有 `/api/internal/gateway/readiness` 端点只接受 nonce、由启动 token 和精确运行时身份派生的 HMAC，并返回匹配的响应证明；运行时端口上的任意监听器都不能满足 Gateway 的就绪检查。
- 凭据和 principal 断言在各自的解析与请求边界失败关闭。运行时 bearer token 不会通过公开服务字段暴露。
- 读取私有 JSON 响应的 Consumer 使用带领域上限和可选 `AbortSignal` 的 `readGatewayResponseJson()`（或字节级配套函数）；分块 body 超过上限或收到取消信号时会被取消，因此保护不只依赖 `Content-Length`。

`plugin-admin` 用途仅允许已声明的 Profile 管理 HTTP 方法以及 `settings.describe`、`settings.mutate`。设置方法会重新核验当前管理员权限；写入必须携带已读版本，且不能修改账户偏好。此用途不授予原生文档打开器、凭据 API、终端或会话执行权限。

### 执行授权

本插件为所属应用标记 `executionAuthorityRequired`。该要求一直保留到应用销毁，授权提供者卸载也不会移除。[Gateway Execution](../gateway-execution/README.zh.md) 拥有执行、权限预设和 profile 管理策略。它使用本包已验证的交互调用者与私有传输；对于委派和恢复工作，则使用真正 Agent 的持久参与者引用。

## 不变量

**运行时不变量：** 未发布配套入口。启动凭据绑定固定进程身份，并在请求准入时检查；本包没有可与该身份比较的独立投影。

## 模型体验

没有直接影响；请求上下文仅完成宿主操作认证，不贡献任何模型输入。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

- **仅限 Gateway 启动的运行时** — 未提供有效私有启动凭据时加载插件会导致启动失败。
- **请求上下文不是执行授权** — 保留的 `current()` 主体标识起始分发。后台、委派和恢复工作必须使用 [Execution Authority](../execution-authority/README.zh.md)；先前请求不能证明当前特权。
- **短期断言** — Gateway 的交付默认值把 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 设为 30 秒。已验证主体会固定其项目 scope 模式直到 `expiresAt`；Session 消费方使用 `ctx.collaboration` 取得当前成员身份与 ACL 决定。代理过期和访问失效处理由 [Gateway](../../../gateway/README.zh.md) 负责。
