---
description: "在右侧边栏标签页中查看或操控远程机器的桌面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-desktop

[English](README.md) | 中文

## 概述

为已授权的远程节点在右侧边栏打开 `remoteDesktop` 标签页。标签页探测端点状态，当覆盖授权集发生变化时要求一次显式确认手势，随后通过一次性 WebSocket 令牌打开 RFB 画面。仅查看授权以只读方式挂载画面；可操控授权转发指针与键盘输入。

## 目录

- [使用本包](#use-this-package)
- [实现解析](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web profile 中组合本插件；它注册 `remoteDesktop` 侧边栏标签类型。调用方通过 `openTabIn(sessionId, 'remoteDesktop', { params: { nodeId, desktop? } })` 打开标签页。

标签页经 `ctx.remoteDesktops` 读取端点状态。当调用方的授权集尚未获得确认时，卡片标明确切级别——**仅查看**或**可操控**——以及管理员开启录制时的录制标志；**确认并连接**记录确认并完成挂载。当确认已覆盖授权时，标签页直接挂载。拒绝会以稳定能力码呈现本地化提示并提供**重试**。存活的附件显示有效级别并提供**断开连接**；已关闭的流提供**重新连接**，按已记录的确认重走 status → attach 流程。

<a id="understand-the-implementation"></a>
## 实现解析

<details>
<summary>实现细节——点击展开</summary>

全部授权都在能力层执行：标签页仅通过 `ctx.remoteDesktops`（remote-desktop controller 的 client 半边）执行 `status → confirm → attach`，并用打包的 `@novnc/novnc` `RFB` 类挂载返回的 `ws(s)://` 流 URL。`viewOnly` 跟随挂载 spec 的级别，但 VNC provider 还会在流内部过滤客户端输入消息，因此伪造的操控请求在仅查看授权下仍无法注入输入。引导入口仅列出调用者当前会话可挂接的授权（`listGrants` 带 `attachable`），绑定其他会话的会话作用域授权不会成为目标。授权、级别、撤销与审计管理位于同级的 `ui-remote-desktop-admin` 设置节中。

`openScreen` 回调属于注入面的一部分，因此测试可在没有 RFB 引擎的情况下挂载标签页主体。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [远程桌面能力](../../remote-desktop/remote-desktop/README.zh.md)
- [VNC provider](../../remote-desktop/remote-desktop-vnc/README.zh.md)
- [远程桌面管理](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-remote-desktop-admin)（仓库内为 README.zh.md）
- [右侧边栏](../../client/ui-sidebar-right/README.zh.md)

**运行时不变量：** 未发布配套入口。attach 状态与目标列表每次渲染都取自 `ctx.remoteDesktops`；插件不保留能力层记录的影子副本。

<a id="model-experience"></a>
## 模型体验

无：桌面查看器与 attach 流程是人类操作的面——Agent 的 computer use 仍是独立的缝——不注册任何模型可见内容。

#### KV Cache 影响

无；本插件不贡献任何模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 引导菜单仅覆盖基于授权的目标发现；存在端点但调用者无授权的目标不会显示。
- 流 URL 相对页面源站解析；在其他源站上挂载 RFB 的部署应扩展 `ClientRemoteDesktops.attach`，而不是在本层做代理。
- provider 产出的 RFB 录制尚无产品内回放面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
