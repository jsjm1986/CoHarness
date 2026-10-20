---
description: "ctx.remoteDesktop 的 VNC/RFB Provider——JSONL 授权存储、同意覆盖的 resolve → confirm → attach → serveStream 流、仅追加审计日志，以及在 view-only 附件上丢弃输入帧的 RFB 泵"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-desktop-vnc

[English](README.md) | 中文

**`VncRemoteDesktop`** 在 RFB 协议上实现 `ctx.remoteDesktop`：将管理员授权存入 JSONL 文件，强制执行 `resolve → attach → serveStream`，并把每个升级后的 socket 泵到配置的 VNC 端点。`view` 附件把客户端→服务端字节经 `RfbClientFilter` 过滤，按键、指针与剪贴板帧在 Provider 内部被丢弃。

## 概要

当 harness 需要向运行 VNC 服务端的机器（macOS 屏幕共享、UltraVNC、KasmVNC、x11vnc）提供人类远程桌面访问时安装本 Provider。管理员通过服务的 `grant`/`revoke`/`setLevel` 管理授权；用户每授权集 `confirm` 一次，随后 `attach` 并用一次性 token 打开返回的流路径。

## 目录

- [配置](#configuration)
- [附件流程](#attachment-flow)
- [view-only 强制](#view-only-enforcement)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 字段 | 语义 |
|---|---|
| `endpoints` | `{ nodeId, desktop?, host, port }` 行；重复目标键在装载时报错。 |
| `grantsFile` | JSONL 授权存储路径，每次变更原子重写；`':memory:'` 选择易失存储。 |
| `recordingDir` | 接收带 `recording` 标志授权的 `<sessionId>.rfb` 原始流捕获的目录；为空则禁用，带标志的 `serveStream` 失败。 |
| `streamPath` | 流挂载提供的路径名；客户端追加 `?token=`；默认 `/remote-desktop/stream`。 |
| `attachTokenTtlMs` | attach token 有效期窗口；默认 `60000`。 |
| `auditFile` | 仅追加 JSONL 审计路径；`':memory:'` 选择易失窗口。 |
| `auditCapacity` | `audit()` 查询保留并从文件尾部重载的审计事件数；默认 `1024`。 |
| `probeTimeoutMs` | `status` 端点探测超时；默认 `3000`。 |

<a id="attachment-flow"></a>
## 附件流程

`confirm` 解析调用者授权，记录覆盖已解析授权集、达到请求级别的同意（一条 `consent` 审计事件），并返回 spec 让调用者获知录制标志。随后 `attach` 再次解析，要求存在覆盖同意（否则 `REMOTE_DESKTOP_CONSENT_REQUIRED`——授权集中新增授权、级别提升或重启都需重新 `confirm`），铸造一次性品牌化 token，返回 `{ path, token }`。传输挂载在 `path` 升级客户端 socket 并调用 `serveStream(token, socket)`；Provider 恰好消费一次 token，拨号到配置端点，泵至任一侧关闭。`detach` 与泵拆除共用一条提交路径，记录 `detach` 审计事件并发出 `remote-desktop/attached`。已消费的 token 在任何泵前失败（端点缺失、拨号不可达、录制器无法打开）时拆除其会话；未消费的 token 在 `attachTokenTtlMs` 后过期并进入同一条 detach 路径。`revoke` 与 `setLevel` 按剩余授权重估每个存活会话：已解析级别不再被授权的会话被拆除并记录审计。

<a id="view-only-enforcement"></a>
## view-only 强制

`RfbClientFilter` 解析客户端→服务端方向：版本前导、安全类型选择、认证响应与 `ClientInit` 全部放行，之后仅转发 `SetPixelFormat`、`SetEncodings` 与 `FramebufferUpdateRequest` 帧。`KeyEvent`、`PointerEvent` 与 `ClientCutText` 被消费并计数；未知消息类型与无法成帧的安全类型按失败关闭处理并拆除连接。

<a id="model-experience"></a>
## 模型体验

无模型可见面；其中任何内容都不进入提示、工具 schema 或模型结果。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- view-only 过滤器可成帧 `None` 与 `VNC authentication` 安全类型；其余类型（Tight、VeNCrypt、Apple DH）在 `control` 附件下可通，但拒绝 `view` 附件。
- 同意是内存态：重启后每个授权集需一次新的 `confirm`；`auditFile` 使审计轨迹本身持久。
- 录制捕获原始 RFB 流；回放/转码不在范围内。
- 端点可达性经由受保护的 `dial` 缝；将其接入 remote-session 反向隧道是后续集成工作。
- `':memory:'` 授权存储适用于测试与开发；生产部署必须设置 `grantsFile`。

<a id="dev-note"></a>
## 开发说明

泵在 Node 流 pause/resume 之外无额外背压语义；服务端→客户端流量占主导且按设计不过滤。不发布 `./invariant` 伴随包——存储/泵关系已在 `tests/` 中直接验证。
