---
description: "在设置中管理远程桌面授权：签发、调级、撤销与审计。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-desktop-admin

[English](README.md) | 中文

## 概述

在设置中新增**远程桌面**节，管理员可在此签发授权、调整级别、撤销授权并查看能力层的审计事件。非管理员只能看到自己的记录——controller 执行同样的范围限定，因此本节无需角色判断即可渲染。

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

在 Web profile 中组合本插件；它注册一个 `settings.section` 条目，排在内建节之后。打开设置 → **远程桌面**即可管理授权。

签发表单接收目标 `nodeId`（及可选 `desktop`）、被授权 principal、级别、范围——长期机器授权或必填过期时间的会话授权——以及录制标志。每行的操作可调级或撤销；**显示已撤销**列出历史记录。审计尾部按新到旧呈现确认、授权、撤销、调级、挂载与卸载事件。

<a id="understand-the-implementation"></a>
## 实现解析

<details>
<summary>实现细节——点击展开</summary>

本节的 React-free controller（`admin-store.ts`）持有快照存储，并以调用方当前选中的 Session id 调用 `ctx.remoteDesktops`——Remote 命名空间从该 Session 的已验证创建者推导调用方身份，因此 UI 不接受任何 principal。所有写操作完成后刷新授权行；卸载时的 abort 信号取消读取。管理员权限本身在服务端强制；非管理员只看到自己的行，管理写会得到 `remote-desktop/forbidden`。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [远程桌面能力](../../remote-desktop/remote-desktop/README.zh.md)
- [远程桌面 BFF](../../api/remote-desktop-controller/README.zh.md)
- [远程桌面标签页](../ui-remote-desktop/README.zh.md)

**运行时不变量：** 未发布配套入口。存储镜像的是经 `ctx.remoteDesktops` 取得的服务端授权与审计状态；权威记录归能力层所有。

<a id="model-experience"></a>
## 模型体验

无：授权管理区是人类操作的设置面，不注册任何模型可见内容。

#### KV Cache 影响

无；本区不贡献任何模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 管理操作绑定当前选中的 Session；未选中 Session 时本节提示需要打开会话，而不是猜测身份。
- 审计尾部未分页；依赖大型持久审计文件的部署按能力层的尾部容量读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
