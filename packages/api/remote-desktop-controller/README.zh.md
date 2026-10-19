---
description: "ctx.remoteDesktop 的浏览器 BFF 控制器——remoteDesktop/* Remote 命名空间，把已认证人类权限映射到授权管理、attach、status 与 audit"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-remote-desktop-controller

[English](README.md) | 中文

**`RemoteDesktopController`**（`ctx.remoteDesktopController`，Remote 命名空间 `remoteDesktop`）是浏览器与 `ctx.remoteDesktop` 之间的 BFF。每个方法为身份验证调用者的会话权限，把授权执行委托给能力层，绝不接受调用方提供的 actor。

## 概要

控制器在 Remote 传输上暴露 `status`、`attach`、`listGrants`、`grant`、`setLevel`、`revoke` 与 `audit`。会话作用域调用（`status`、`attach`）授权被寻址会话并把验证过的 `creator` 绑定为 principal；管理调用额外要求经 `userTerminalAdministration` 的管理员权限。独立部署中本地操作员同时具备两种角色。

## 目录

- [方法](#methods)
- [授权](#authorization)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="methods"></a>
## 方法

| 方法 | 会话作用域 | 角色 | 语义 |
|---|---|---|---|
| `status(agent, target)` | 调用者会话 | 任一授权持有者 | 端点可达性、附件数，以及调用者的授权摘要（`level`/`recording`/`consented`）。 |
| `confirm(agent, target, level)` | 调用者会话 | 匹配的授权 | 记录覆盖已解析授权集的同意；返回被确认的 spec（含 `recording`）。 |
| `attach(agent, target, level)` | 调用者会话 | 匹配的授权 + 覆盖同意 | 返回 `{ id, spec, stream }`；无前置 `confirm` 则以 `remote-desktop/failure` `REMOTE_DESKTOP_CONSENT_REQUIRED` 失败。 |
| `listGrants(agent, filter)` | 调用者会话 | admin 见全部；其他见本人 principal | 授权行，可选包含已撤销。 |
| `grant(agent, input)` | 管理员会话 | admin | 签发归属调用者的授权。 |
| `setLevel(agent, grantId, level)` | 管理员会话 | admin | 修改授权级别。 |
| `revoke(agent, grantId)` | 管理员会话 | admin | 撤销授权。 |
| `audit(agent, filter)` | 调用者会话 | admin 见全部；其他见本人 principal | 审计事件，最新在前。 |

<a id="authorization"></a>
## 授权

`RemoteDesktopAccess` 沿用终端控制器的模式：托管部署（存在 execution-authority）把身份委托给 `userTerminalAuthorization`、管理员角色委托给 `userTerminalAdministration`，策略缺失时失败关闭；独立部署回退到具备管理员权限的 `local-operator` 身份。服务端仍独立执行——即使部署错误接线策略，管理方法也拒绝非 admin actor。

<a id="client-half"></a>
## Client 半边

`@deepseek-ai/dsh-api-remote-desktop-controller/client` 安装 `ctx.remoteDesktops`（`ClientRemoteDesktops`）：自挂载生成的 `remoteDesktop` Remote 贡献（`./remote`），把每个 `{ ok }` 线侧结果转为抛出的错误，并把 `attach` 返回的 `{ path, token }` 解析为相对 `location` 的绝对 `ws(s)://` URL。UI 插件（`ui-remote-desktop`、`ui-remote-desktop-admin`）消费该服务而非直接使用线侧命名空间。

<a id="model-experience"></a>
## 模型体验

无模型可见面；纯人类 BFF。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- `serveStream` 由能力层暴露而非本命名空间；`dsh-remote-desktop-stream` 挂载 WebSocket 路径（`stream.path` + `?token=`）。
- 能力层拒绝以 `remote-desktop/failure` 呈现，`code` 字段携带稳定的 `RemoteDesktopErrorCode`；`remote-desktop/forbidden` 仍是控制器侧管理员检查的线缆码。
- detach 是隐式的（流关闭）；显式强制 detach 管理方法延后。
- 会话作用域授权以调用者会话做授权匹配；代表其他会话的授予通过管理员权限下的 `scope.sessionId` 载荷完成。
