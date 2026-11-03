---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-gateway-runtime

[English](README.md) | 中文

供 Gateway 启动的 Harness 运行时使用的认证请求上下文和私有 loopback 传输。启动凭据将进程绑定到一个组织、一个个人或项目运行时身份，以及用于验证短期浏览器 principal 的 Gateway 密钥。

插件向已认证的 Gateway 发布已提交的工作区元数据，不传输 Session 正文。个人 Runtime 还需要 `apiProxy`，通过其现有会话目录发布根对话摘要；项目 Runtime 只发布 Workspace 元数据，不读取其他参与者的对话目录。同一时间只有一次发布，后续变更合并为最新快照；卸载时中止并等待请求结束。`workspaceCatalogTimeoutMs` 限制单次发布时长，默认 30000 毫秒。

发布序号由应用根作用域拥有，在注册表或传输提供方替换后继续递增。因此，替换后的发布能够更新旧目录，迟到的旧请求也无法将其覆盖。计数器到达安全整数上限时停止，不会回绕；新应用仍须遵守 Gateway 的运行时代际规则。参见[发布顺序决策](../../../.agents/notes/implemented/bug-fix/2026-11-01-workspace-publication-revision.zh.md)。

每个 Runtime 在 `runtime-execution` 设置中保存运行策略：`mode` 默认为 `resident`，也可明确选择 `on-demand`。项目中的修改沿用现有项目管理员设置权限。常驻模式保留已经运行的进程，不会启动未使用的环境或重启已停止的电脑。按需模式只有在 Host 确认没有运行中的 Agent、维护操作、待处理输入、终端、作业、记忆处理或待触发定时任务后，才允许自动空闲回收。自开发插件有持续工作时通过 `runtime/idle-release-check` 返回 `busy`；完成适配前保持常驻。受认证的就绪响应单独签名运行策略和空闲判断；依赖不可用或检查失败时保留运行。参见[空闲回收决策](../../../.agents/notes/implemented/architecture/2026-11-03-runtime-idle-background-protection.zh.md)。

## 概述

使用 `dsh-gateway-runtime` 获得 Gateway 启动的 Harness 运行时的已认证请求上下文与私有 loopback 传输。启动凭据把进程绑定到一个组织与一个个人或项目运行时身份，并为其他协作包验证短生命周期浏览器主体。

## 目录

- [运行时约定](#runtime-contract)
- [资源准入](#resource-admission)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="runtime-contract"></a>
## 运行时约定

- 启动凭据必须且只能从 `DSH_GATEWAY_CREDENTIAL_FD` 或 `DSH_GATEWAY_CREDENTIAL_FILE` 之一读取。它包含仅限 loopback 的 Gateway origin、运行时 bearer token、运行时 generation、组织和 Ed25519 公钥。 应用根保留已验证的凭据与已解码的公钥，使提供方及模块替换复用同一启动身份；其他应用读取自己的通道。首次读取失败不会被保留。应用关闭时移除这个私有且不可枚举的保留值。不同的启动身份需要新应用。
- 运行时注册 `connection/authenticate` provider，使 Connection 在浏览器令牌交换与 Cookie 之前就向 index、`/api`、通用通道和事件流放行已验证的 principal；经 Gateway 启动的进程绝不单独接受浏览器凭据。每个受限用途的断言只接受其声明的 HTTP 方法和路径，绝不能提供 index 或开启事件流。
- `connection/request` 监听器要求 `x-dsh-gateway-principal`，验证其签名、有效期、组织、scope、运行时身份和 generation，再通过请求局部的 `current()` / `requireCurrent()` 暴露它。
- 已分配环境在私有凭据与每份 principal 中携带相同 `runtimeId`。旧式单实例组合在两者中都省略它；不匹配或仅一方省略时拒绝认证。
- `interactive()` 只在认证 HTTP 操作仍活动时暴露该主体。`current()` 标识起始认证分发，并可以沿异步上下文传递；它不会向脱离请求的工作授予交互权限。
- `request()` 只接受凭据 loopback origin 上的绝对 `/internal/runtime/` 路径，加入私有 bearer token，并且只在调用方明确要求时转发浏览器 principal。
- 流式请求体明确提供 `duplex: 'half'`；传输保留这一 Node fetch 选项，不缓冲请求体。
- 私有 `/api/internal/gateway/readiness` 端点只接受 nonce、由启动 token 和精确运行时身份派生的 HMAC，并返回匹配的响应证明；运行时端口上的任意监听器都不能满足 Gateway 的就绪检查。 `requiredPlugins` 默认空列表；每个配置的 Loader 条目 id 必须恰好对应一个已激活条目。Loader 缺失、条目不存在、未激活或存在歧义均返回503。Gateway 组合要求模型治理、执行授权及已启用的目录守卫。
- 凭据和 principal 断言在各自的解析与请求边界失败关闭。运行时 bearer token 不会通过公开服务字段暴露。
- 读取私有 JSON 响应的 Consumer 使用带领域上限和可选 `AbortSignal` 的 `readGatewayResponseJson()`（或字节级配套函数）；分块 body 超过上限或收到取消信号时会被取消，因此保护不只依赖 `Content-Length`。读取失败会发起取消，无须等待清理确认即可保留原始错误并释放 reader 锁；传输所有者仍须独立确认实际连接已关闭。

`plugin-admin` 用途仅允许已声明的 Profile 管理 HTTP 方法以及 `settings.describe`、`settings.mutate`。设置方法会重新核验当前管理员权限；写入必须携带已读版本，且不能修改账户偏好。此用途不授予原生文档打开器、凭据 API、终端或会话执行权限。

`archive-read` 用途仅允许 `GET /api/internal/archive/read`。`document-admin` 用途仅允许 `POST /api/documents/trash`、`POST /api/documents/restore` 和 `DELETE /api/documents/purge`。管理员角色不会把这些断言的权限扩展到其他操作；接收服务仍会检查业务权限。Gateway 的私有运行时 API 会独立检查端点是否明确允许该用途，再调用携带 principal 的操作；这些断言不会向无关回调授予权限。

凭据 origin 接受 HTTP 上的规范 `127.0.0.1`、`localhost` 和 `[::1]` 主机，不允许用户信息、路径前缀、查询或片段。损坏 JSON 和 origin 的诊断不包含输入摘录，也不保留携带输入字节的引擎错误属性。通道 I/O 失败仍保留文件和错误码上下文。

### 执行授权

本插件为所属应用标记 `executionAuthorityRequired`。该要求一直保留到应用销毁，授权提供者卸载也不会移除。[Gateway Execution](../gateway-execution/README.zh.md) 拥有执行、权限预设和 profile 管理策略。它使用本包已验证的交互调用者与私有传输；对于委派和恢复工作，则使用真正 Agent 的持久参与者引用。

项目凭据会在应用根上下文中保留[协作要求](../collaboration/README.zh.md#application-authorization)，覆盖运行时或授权提供方的替换过程。

<a id="resource-admission"></a>
## 资源准入

`./resource-budget` 提供方先注册精确的 Runtime 代次，再发布 `resourceBudget`。托管组合将 LLM 与 subprocess 启动安排在其后；Gateway 就绪也要求完成注册，且本地提供方可用。`resourceBudgetRequired` 保留在应用根上下文直到销毁，因此撤下提供方不会恢复不受限执行。

`modelAccessRequired` 同样保留在应用根上下文直到销毁。受管模型请求在准入和最终派发期间必须保有原策略所有者；卸载或替换提供方不会放行不受限调用。

提供方在进入有界注册队列前，捕获 Session 范围、签名交互调用者或明确的基础设施归属。归属解析失败会立即拒绝。尚未发送的请求被取消时，会独立于此前的 HTTP 请求释放本地排队容量。已验证且仍有效的条目串行注册；已尝试注册的请求则保留精确的完成记账，直到得到确认。

它使用已提交的节点策略与串行操作身份；排队许可需要 Gateway 重新授权。`requestTimeoutMs` 默认为 5000，`cleanupTimeoutMs` 默认为 30000，清理预算必须大于单次请求。许可取消跟随提供方生命周期、调用方和操作，不依赖不确定确认后已移除的本地条目。销毁时取消所有者，在该预算内等待确认清理，并保留不确定占用。之后精确的原所有者仍可通过捕获的私有传输报告静止状态。

<a id="model-experience"></a>
## 模型体验

没有直接影响；请求上下文仅完成宿主操作认证，不贡献任何模型输入。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅限 Gateway 启动的运行时** — 未提供有效私有启动凭据时加载插件会导致启动失败。
- **请求上下文不是执行授权** — 保留的 `current()` 主体标识起始分发。后台、委派和恢复工作必须使用 [Execution Authority](../execution-authority/README.zh.md)；先前请求不能证明当前特权。
- **短期断言** — Gateway 的交付默认值把 `HGW_PRINCIPAL_ASSERTION_TTL_MS` 设为 30 秒。已验证主体会固定其项目 scope 模式直到 `expiresAt`；Session 消费方使用 `ctx.collaboration` 取得当前成员身份与 ACL 决定。代理过期和访问失效处理由 [Gateway](../../../gateway/README.zh.md) 负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
