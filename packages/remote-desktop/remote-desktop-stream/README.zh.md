---
description: "ctx.remoteDesktop 的 WebSocket 挂载——ctx.webServer 上的一条 upgrade 路由、?token= 握手，以及喂给 serveStream 的 ws→Duplex 适配器"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop-stream

[English](README.md) | 中文

**`remote-desktop-stream`** 是 `ctx.remoteDesktop` 的 Web 传输挂载。它在 `ctx.webServer` 上注册一条精确路径的 upgrade 路由（默认 `/remote-desktop/stream`），完成 WebSocket 握手，把套接字适配为 `Duplex`，并用 `?token=` 携带的一次性 token 调用 `RemoteDesktop.serveStream`。

## 概述

浏览器客户端在 `remoteDesktop/attach` 之后打开 `wss://<host><stream.path>?token=<token>`；挂载本身不消费任何东西——`serveStream` 校验并恰好消费一次 token，随后在流内以已解析级别泵 RFB。文本帧以 1003 状态码关闭套接字；缺失或无效 token 直接销毁连接。token——每次 attach 铸造、单次使用、TTL 有界——就是流凭据；路由不执行单独认证。

## 目录

- [组合](#composition)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="composition"></a>
## 组合

与 `ctx.remoteDesktop` Provider（`dsh-remote-desktop-vnc`）和 `ctx.webServer` 一起加载。插件使用 `ctx.inject(['webServer', 'remoteDesktop'])`，仅在两者存在时激活；Provider 的 `streamPath` 配置必须与本插件一致，`attach` 才会通告到已挂载的路径。

**运行时不变量：** 未发布配套入口。本挂载只持有逐连接的 WebSocket 管线；token 与附件的真相留在 `ctx.remoteDesktop`。

<a id="model-experience"></a>
## 模型体验

无：本传输挂载中继人类的屏幕与输入帧，不增加任何模型输入。

#### KV Cache 影响

无；本挂载不贡献任何模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- Origin 策略与外层请求拒绝（`connection/request` waterfall）属于 client-connection 层的职责；本挂载直接注册在 `ctx.webServer` 上。
- ws↔Duplex 边界的背压是单向的：入站 `ws` 消息在泵停滞时不会暂停套接字（应用 Node 缓冲）；出站方向遵循 `send` 回调。
- 向连接客户端的录制披露由 `confirm`/`status` 同意流覆盖，而非本套接字。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
