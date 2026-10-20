---
description: "DeepSeek Harness 的远程桌面能力缝（ctx.remoteDesktop）——授权词汇（机器/会话作用域、view/control 级别）、RemoteDesktop 服务（resolve → attach）以及 remote-desktop/* 事件词汇"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop

[English](README.md) | 中文

**`RemoteDesktop`**（`ctx.remoteDesktop`）是面向人类的远程节点桌面查看与操作能力。它拥有授权词汇——`view` 或 `control` 级别的持久机器作用域授权与有界会话作用域授权——强制的 `resolve → attach` 决策点、`remote-desktop/*` 事件词汇以及审计事件分类法。它不拥有传输、端点解析或浏览器客户端。

## 概述

当应用需要受治理的人类远程桌面访问时使用 `dsh-remote-desktop`。管理员通过 `grant`/`revoke` 签发授权；请求方用户对实时授权解析附件规格，并打开一个会话，其流端点由浏览器客户端连接。`view` 访问需要显式授权；`control` 额外要求授权级别，并在 Provider 的流内部强制执行，因此 `view` 附件下无法注入输入事件。

## 目录

- [服务 API（`ctx.remoteDesktop`）](#service-api-ctxremotedesktop)
- [`remote-desktop/*` 事件](#the-remote-desktop-events)
- [授权模型](#grant-model)
- [词汇](#vocabulary)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="service-api-ctxremotedesktop"></a>
## 服务 API（`ctx.remoteDesktop`）

Provider 子类化 `RemoteDesktop` 并实现十个成员。

| 成员 | 语义 |
|---|---|
| `resolve(request, signal?)` | 为 `{ target, principal, sessionId? }` 匹配实时授权，计算有效级别（永不超过授权），产出包含录制标志的强制规格。无有效授权时抛出 `REMOTE_DESKTOP_FORBIDDEN` 的 `RemoteDesktopError`——解析绝不静默收窄或放宽。 |
| `confirm(request, signal?)` | 解析请求，针对已解析的授权集与级别记录调用者的同意（一条 `consent` 审计事件），并返回调用者确认的规格。 |
| `attach(request, signal?)` | 先解析，再要求存在覆盖已解析授权集且达到请求级别的同意——否则抛出 `REMOTE_DESKTOP_CONSENT_REQUIRED`——建立桌面传输与流端点，返回拥有 `detach` 的 `RemoteDesktopSession`。实现仅在 attach 提交后发布 `remote-desktop/attached`。 |
| `serveStream(token, socket, signal?)` | 消费 `attach` 铸造的一次性 token，解析挂起规格，并在升级后的套接字上以泵内强制的有效级别传输桌面协议。 |
| `status(actor, target, options?, signal?)` | 读取一个桌面端点的实时远端状态：可达性、附件数与调用者的授权摘要；要求 `actor.principal` 至少有一条存活授权。 |
| `listGrants(actor, filter?, signal?)` | 列出授权；已撤销行需要 `includeRevoked`，`attachable` 将结果限制为调用者当前可挂接的授权——`sessionId` 的存活作用域，且目标已配置端点。非管理员 actor 只能看到自己 principal 的行。 |
| `grant(input, actor)` | 签发授权；要求 `actor.admin === true`。仅在写入提交后发布 `remote-desktop/grants-changed`。 |
| `setLevel(id, level, actor)` | 修改授权级别；要求 `actor.admin === true`。 |
| `revoke(id, actor)` | 按 id 撤销授权；要求 `actor.admin === true`。 |
| `audit(actor, filter?, signal?)` | 查询能力自有的审计事件，最新在前，可选按 target 或 principal 过滤；非管理员 actor 只能看到自己的事件。 |

<a id="the-remote-desktop-events"></a>
## `remote-desktop/*` 事件

本包声明两个 emit 事件。`remote-desktop/grants-changed` 在授权集提交后触发，供管理视图与缓存授权刷新。`remote-desktop/attached` 在附件打开或关闭后触发，携带会话与布尔方向。

<a id="grant-model"></a>
## 授权模型

两种作用域并存，在 resolve 时一并匹配：

- **机器作用域**——对节点桌面的持久访问；无过期。
- **会话作用域**——绑定 `SessionId` 与必需 `expiresAt` 的有界访问。

有效级别取所有匹配的活跃授权中的最高级别；会话授权可以提升但不能静默降级持久机器授权。`view` 绝不默认放开——每个访问级别都需要授权。Provider 在其流路径内强制执行解析出的级别（`view` 附件丢弃远程输入事件），因此 UI 可见性永远不是执行点。

<a id="vocabulary"></a>
## 词汇

`RemoteDesktopGrantId` / `RemoteDesktopSessionId` / `RemoteDesktopToken` 为品牌化不透明 id。`RemoteDesktopTarget` 命名一个节点加可选桌面标识（省略则选主桌面）。`RemoteDesktopSpec` 是解析出的契约：目标、有效级别、授权来源与录制标志。`RemoteDesktopSession` 携带品牌化会话 id、其规格以及浏览器客户端打开的一次性流端点（`path` + `token`）。`RemoteDesktopAuditEvent` 为封闭分类法——`consent`、`grant`、`revoke`、`set-level`、`attach`、`detach`、`level-escalate`——归属显式 `RemoteDesktopActor`。失败抛出携带稳定 `RemoteDesktopErrorCode`（`REMOTE_DESKTOP_FORBIDDEN`、`REMOTE_DESKTOP_TARGET_UNAVAILABLE`、`REMOTE_DESKTOP_GRANT_NOT_FOUND`、`REMOTE_DESKTOP_GRANT_EXPIRED`、`REMOTE_DESKTOP_STALE_TARGET`、`REMOTE_DESKTOP_TRANSPORT`、`REMOTE_DESKTOP_CONSENT_REQUIRED`）的 `RemoteDesktopError`。完整契约见 `src/types.ts`。

**运行时不变量：** 未发布配套入口。Service Definition 只声明契约；provider 实现拥有一切可观测的运行时关系。

<a id="model-experience"></a>
## 模型体验

无：本能力通过 API 与浏览器客户端服务人类桌面访问；其中任何内容都不进入提示、工具 schema 或模型结果。

#### KV Cache 影响

无；本能力不贡献任何模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 审计事件分类法在此定义；持久审计存储随其 Provider 落地（见 `@deepseek-ai/dsh-remote-desktop-vnc`）。
- 屏幕录制是规格上携带的每授权标志；录制管线属于 Provider 行为。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包仅拥有 Service Definition——不含 Provider 实现。

</details>
