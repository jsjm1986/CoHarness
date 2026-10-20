---
description: "远程桌面栈：面向人类的能力缝（授权模型、强制的 resolve → attach、审计分类法）、带 view-only 输入过滤的 VNC/RFB Provider，以及面向浏览器的 BFF 控制器命名空间。"
kind: "package-group"
---

# remote-desktop/ - 人类远程桌面族

[English](README.md) | 中文

远程桌面栈让已认证的人类查看和操作远程节点的桌面：授权词汇（`view`/`control` 级别的持久机器作用域与有界会话作用域）、强制的 `resolve → attach → serveStream` 决策点、在 view-only 附件上丢弃输入帧的 RFB Provider，以及 `remoteDesktop/*` BFF 命名空间。全部为**产品**包。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `remote-desktop/` | Service Definition：授权模型与作用域、`RemoteDesktop` 服务（`resolve → attach → serveStream`）以及 `remote-desktop/*` 事件/审计词汇 | `ctx.remoteDesktop` |
| `remote-desktop-vnc/` | VNC/RFB Provider：JSONL 授权存储、端点拨号、同意覆盖的 token 附件、泵内的 view-only `RfbClientFilter`，以及仅追加审计日志 | （注册 `ctx.remoteDesktop`） |
| `remote-desktop-stream/` | Web 传输挂载：`ctx.webServer` 上的一条 WebSocket upgrade 路由、`?token=` 握手，以及喂给 `serveStream` 的 ws→Duplex 适配器 | （挂载 `ctx.remoteDesktop`） |
| `api/remote-desktop-controller/` | BFF 控制器：`remoteDesktop/*` Remote 命名空间，把已认证人类权限映射到服务调用 | `ctx.remoteDesktopController` |

Service Definition 位于 `remote-desktop/remote-desktop/`。不同传输（RDP、WebRTC）可替换 `remote-desktop-vnc` 而不影响授权模型或控制器：级别强制位于 Provider 的流路径内，替换实现必须携带同等保证（`view` 附件不能注入输入）。访问绝不默认放开——每个级别都需要管理员授权，会话作用域授权总是携带过期时间。

## 概要

`remote-desktop/` 组为 harness 提供受治理的人类桌面访问：`remote-desktop/` 中的 `ctx.remoteDesktop` 定义授权与强制附件契约；`remote-desktop-vnc/` 在配置的 VNC 端点（macOS 屏幕共享、UltraVNC、KasmVNC/x11vnc）上以 RFB 实现；`api/remote-desktop-controller/` 在已认证会话权限加管理员检查下向浏览器暴露 `status`/`attach`/`listGrants`/`grant`/`setLevel`/`revoke`/`audit`。审计事件记录授权生命周期、attach/detach 与级别提升；录制是 Provider 捕获的每授权标志。
