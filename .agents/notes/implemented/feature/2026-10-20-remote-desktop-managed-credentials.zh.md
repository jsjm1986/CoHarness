# Agent Note：远程桌面端点经由存储凭据在宿主侧终结认证

Status: implemented

[English](2026-10-20-remote-desktop-managed-credentials.md) | 中文

## 问题

每次远程桌面附件都要求操作者在浏览器表单里输入目标机登录凭据：RFB 握手在客户端 socket 上端到端进行，桌面密码因此经过每一个打开流的浏览器。Apple Remote Desktop 认证（安全类型 30）没有匿名模式，所以一台高频使用的机器——部署自身的 Mac mini 端点——让输密码成为最主要的交互成本，而任何面向操作者的凭据存储都会把明文密码交给 web 客户端。

## 决策

端点可以声明 `username` 与 `passwordRef`；只声明 `username` 是装载期与 admin 期配置错误——没有东西可用它认证，登录名没有意义。`passwordRef` 是凭据存储引用——既有的 `ctx.credentials` 缝——永远不是值，因此端点文件与 admin API 只携带标识符。

引用存在时，`serveStream` 走托管握手：Provider 拨号端点，经 `ctx.credentials` 逐流解析引用，在宿主侧完成上游认证，而面向浏览器的 socket 只协商 `None` 安全类型。客户端的 noVNC 会话因此看到一台已认证的桌面，从不渲染凭据表单；密码不经过任何浏览器与任何线。上游协商支持 `None`（1）与 Apple Remote Desktop（30）——Provider 自行执行 ARD Diffie–Hellman 交换，以 `MD5(sharedSecret)` 导出 AES-128-ECB 密钥并提交 128 字节凭据块——两者都不提供的服务端以 `REMOTE_DESKTOP_TRANSPORT` 拒绝。Provider 未挂载、引用解析为空、或凭据被拒都响亮失败：会话拆除并审计，而不是挂在一个无人能答的提示上。

`pumpRfb` 获得 `clientPreamble`/`upstreamPreamble` 选项，托管路径借此注入面向浏览器的 `None` 前导，同时拼接越过各握手边界读出的残余字节。`RfbClientFilter` 分阶段运作：被呈现 `None` 的 view 附件从成帧消息阶段开始——客户端不会再发送上游已消费的安全选择——而交互路径仍先解析前导再进入成帧。

Admin 面携带同一契约：`endpoints.json` 行与 gateway admin 服务接受这两个字段，拒绝有 `username` 无 `passwordRef`（`remote-desktop-username-without-passwordref`）与非 POSIX 的 `passwordRef` 值（`remote-desktop-passwordref-invalid`），端点编辑器标注认证模式而从不要求或显示密码。

## 已考虑的替代方案

**浏览器侧凭据持久化。** 否决：它把机器密码存进 web 客户端状态，并仍经每个发起附件的浏览器传输——与把秘密留在宿主凭据存储内部恰好相反的信任方向。

**专用远程桌面秘密存储。** 否决：`credentials-local` 已持有 `$DSH_HOME/.credentials.yaml`，具备 POSIX 引用校验、分层解析与更新通知；第二套存储会把轮换、备份与权限策略按凭据种类撕开。

**非托管端点也一律宿主侧协商。** 否决：没有存储引用就没有可认证之物，且在交互端点上截获握手会破坏浏览器的 `credentialsrequired` 流程。托管模式恰好在引用存在处启用；其余端点保持既有的端到端握手。

## 后果

管理员在端点配置（或 Admin → Remote Desktop）里一次性设置登录名与引用；操作者附件即入，无提示。交互路径不受影响——无 `passwordRef` 的端点行为与之前完全一致——授权、同意、审计、view-only 过滤与录制语义在两种模式下同样适用。上游协商面刻意收窄：`None` 与 ARD 覆盖 macOS 屏幕共享与常见 Linux VNC 服务端；仅限密码式 VNC 认证（类型 2，DES）的服务端无法托管，在 DES 路径存在前必须保持交互。

`tests/managed-handshake.spec.ts` 对着一个解密真实 AES-ECB 凭据块并还原所提交登录名的内存 ARD 服务端驱动交换，并断言面向浏览器的前导与认证后 view 过滤；`tests/service.spec.ts` 覆盖解析为空的引用、view-only 托管附件、以及有 `username` 无 `passwordRef` 的装载错误；gateway 服务 spec 在 admin 边界拒绝同样的非法组合。

## 验证

`pnpm vitest run packages/remote-desktop/remote-desktop-vnc` 覆盖加密交换、残余字节拼接、过滤与失败模式；`pnpm vitest run gateway` 覆盖 admin schema。
