# Agent Note：远程桌面能力缝

状态：implemented

[English](2026-10-19-remote-desktop-capability-seam.md) | 中文

## 问题

harness 需要受治理的人类远程桌面访问——查看和操作另一台机器的屏幕——且不与 agent 侧的 computer-use 面相混淆。决策点是授权（谁可以查看或控制哪个桌面）、执行（view 附件绝不能在任何地方注入输入，包括协议流内部）以及审计（管理与附件生命周期必须可重建）。

## 决策

三包能力缝拥有人类桌面面；其中没有任何模型侧工具注册。

`dsh-remote-desktop`（`ctx.remoteDesktop`）是 Service Definition：授权词汇（`view`/`control` 级别；持久 `machine` 作用域与携带必需 `expiresAt` 的有界 `session` 作用域）、强制的 `resolve → confirm → attach → serveStream` 流、`remote-desktop/*` 事件词汇以及封闭的 `RemoteDesktopAuditEvent` 分类法。`resolve` 是唯一决策点——匹配活跃授权（未撤销、绑定 principal、绑定 target、作用域有效），并抛出 `REMOTE_DESKTOP_FORBIDDEN` 而非静默放宽或收窄。两种作用域并存；有效级别取匹配授权中的最高级别，因此会话授权可以提升但绝不静默降级持久机器授权。`view` 绝不默认放开——每个级别都需要授权。`confirm` 记录覆盖已解析授权集、达到请求级别的同意；`attach` 要求存在覆盖同意，否则抛出 `REMOTE_DESKTOP_CONSENT_REQUIRED`——授权集中新增授权、级别提升或重启都需重新手势。

`dsh-remote-desktop-vnc` 是 VNC/RFB Provider：JSONL 授权存储（每次变更原子重写）、仅追加 `auditFile` JSONL 日志（其尾部供给有界 `audit()` 窗口）、每目标配置端点、内存中的同意记录、一次性 attach token（恰好消费一次、TTL 有界），以及 `pumpRfb`——级别在流内部强制执行。`RfbClientFilter` 解析确定性的客户端握手（版本、安全类型选择、认证响应、ClientInit），使输入无法藏在未成帧前导中，之后仅转发 `SetPixelFormat`/`SetEncodings`/`FramebufferUpdateRequest`，并消费 `KeyEvent`/`PointerEvent`/`ClientCutText` 计数丢弃；未知消息类型与无法成帧的安全类型按失败关闭处理。`grant.recording` 把服务端→客户端流旁录为 `recordingDir` 下的 `<sessionId>.rfb`。

过滤器采用 [RFC 6143 §7.5](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.5) 的线协议编号：放行 0/2/3，丢弃 4/5/6。协议夹具按规范构造字节；真实 noVNC 浏览器流程还针对独立 RFB 对端验证协商、可见像素与输入投递，避免解析器与单测夹具共享同一个编号错误却被视为互通证据。

`dsh-remote-desktop-stream` 是 Web 传输挂载：`ctx.webServer` 上一条精确路径的 WebSocket upgrade 路由、`?token=` 握手，以及喂给 `serveStream` 的 ws→`Duplex` 适配器。铸造的 token——单次使用、TTL 有界——就是流凭据；路由不执行单独认证。

`dsh-api-remote-desktop-controller` 是 BFF：`remoteDesktop/*` TypertRemoteService 命名空间。每个方法经 `gatewayRuntime.interactive()` 从请求自带的已验证 Gateway 断言解析调用者 actor（身份=断言用户名，admin=断言角色），并把执行委托给能力层——即使部署错误接线策略，服务端拒绝仍然成立。授权基座已从本笔记最初记录的终端授权委托修正，见[交互断言笔记](2026-10-20-remote-desktop-interactive-principal.zh.md)。`REMOTE_SESSION_POLICIES` 声明每个方法的会话路径与读/写分类；attach 为 `execution: 'request'`（人类手势启动远程执行）。

受管 VNC 是否启用由节点部署设置 `HGW_REMOTE_DESKTOP` 明确决定，与 Computer Use、图形会话检测及用户资格相互独立。关闭后，新 Runtime 配置不包含 Gateway 私有桌面文件，但保留通过鉴权的控制器和环境元数据。这样，无 GUI 工作区无需为了打开页面而授予 Unix 用户读取 Gateway 私有存储的权限，也不会屏蔽无 GUI 宿主机上配置的外部 VNC 端点。VNC 初始化归 `Service.init` 所有，存储读取失败时服务不发布，Loader 的失败 fiber 保留错误，避免游离的 Promise 拒绝。

提供方关闭时明确停止新准入并等待已接收操作。附件在拨号及凭据协商期间持续受取消控制；清理会在转发前关闭迟到连接，只记录一次活动会话断开，等待已接收的授权写入并排空审计追加。因此关闭 Promise 表示清理已经完成，而不是只请求关闭已有转发。

## 后果

- 同意是 Provider 上的内存态——重启后每个授权集需一次新的 `confirm`；审计轨迹本身经 `auditFile` 持久。
- `dial` 缝接受替换传输；remote-session 反向隧道路由是集成后续工作。
- view-only 成帧支持 `None` 与 `VNC authentication` 安全类型；其余类型拒绝 view 附件（control 直通）。
- Origin 策略与外层请求拒绝属于 client-connection 层，而非流挂载。

## 备选方案

**授权模型放进 controller。** BFF 本地授权会让每个 Consumer 重复执行；授权模型属于能力词汇。

**在客户端 UI 过滤。** 隐藏输入控件挡不住构造的流；丢弃必须发生在 Provider 的泵内。

**第二条授权缝。** `remoteDesktopAuthorization` 面会迫使部署把同一人类手势策略实现两遍；终端缝已回答"哪个已认证人类在该会话上"。
