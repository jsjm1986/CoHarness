---
description: "English | 中文"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.zh.md) 之上：设置 coding persona，插入 Web 宿主行（webserver、API 网关、workspace、投影缓存、存储）、浏览器插件名录与客户端插件清单实时传输（[`dsh-client-hmr`](../../client/hmr/README.zh.md)，仅在重建 watcher 旁设置 `DSH_CLIENT_HMR=1` 时启用产物轮询），并挂载本包的 `web-runtime` 粘合插件（配置为 `{openBrowser, printUrl, surfaceContext, publicUrl}`）。该插件通过 `@deepseek-ai/dsh-web-frontend` 的 exports 解析已构建的前端 dist，持有对外公告的应用 URL，并在非 loopback bind 以明文 HTTP 服务时告警，挂载 [`frontend-static`](../../host/frontend-static/README.zh.md) 回退席位所有者，并在 `surfaceContext` 为 true 时注册 bash 可见的 `DSH_WEB_URL` 运行时变量。自身 Loader 配置树结算后，它在 `printUrl` 为 true 时打印 `dsh web:` URL 行；`openBrowser` 为 true 且继承的 `SSH_CONNECTION` 与 `SSH_TTY` 均为空或不存在时，才会用默认浏览器打开规范应用 URL（配置了 `publicUrl` 时为公告根，否则为监听器的 bind 地址 URL）。SSH 启动仍保留 URL 行，但会跳过浏览器交接，因为本地转发地址由 SSH 客户端或编辑器持有——`--public-url` 仍会改变打印的根，而在远端宿主机上打开浏览器无法到达你的屏幕。交接前，运行时会打印英文提示 `dsh web: opening the default browser; pass --no-open to disable`。短生命周期 Node helper 使用规范的脱敏子进程环境运行受维护的平台 opener。在 Windows 上，helper 会保持存活，直至短生命周期的 PowerShell launcher 退出，因为 `open` 会在 launcher 把 URL 交给 shell 之前、仅在 spawn 时返回；其他平台则在 opener 接受 spawn 后结束。helper 失败时会向 stderr 写入包含原因和手动访问 URL 的诊断，不会停止服务器，且任何路径都不会等待浏览器退出。本组合包还持有应用命令行：普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），解析 `--host`、`--port`、`--public-url`、可重复的 `--trusted-host`、`--no-open` 以及应用自己的 `--help`，再提供 `webStartup`；本机启动默认会打开浏览器，`--no-open` 则只对本次调用关闭该行为。它会在发布该服务前拒绝通配 `--host`——包括 Linux 读取为 IPv4 any 的 IPv4-mapped 形式——因为绑定所有接口会把远程代码执行暴露给网络；应绑定本机接口的一个具体 IPv4 或 IPv6 地址。由 flag 配置的行会注入该服务，并在惰性配置中直接读取它，因此参数解析完成前不会有任何东西绑定端口，`dsh --profile web --help` 也不会启动服务器。[`dsh-headless`](../headless/README.zh.md) 是同一 base 之上的同级表层，不挂载本组合包。

## 概述

运行 `dsh --profile web`，打开提供聊天、模型与设置管理以及会话历史的浏览器 GUI。它使用与其他 dsh 表层相同的模型访问、工具与安全默认值。启动时会打印带认证信息的 URL，通常还会打开默认浏览器；SSH 会话和 `--no-open` 需要你手动打开。更改端口、允许额外 authority、绑定一个具体的本机 IP，并用自己提供的证书直接提供 HTTPS；通配地址会被拒绝。跨机访问使用剥离前缀代理后公告的 HTTP(S) URL、监听器 TLS，或非 loopback bind 上的明文 HTTP。一次性的命令行任务应使用 `dsh-headless`。

## 目录

- [监听、信任与公开部署](#public-deployments)
- [模型重试默认值](#model-retry-defaults)
- [不变量](#invariants)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="public-deployments"></a>
## 监听、信任与公开部署

默认情况下 GUI 只在 loopback 上监听，只接受本机的连接。只有 `--host` 会改变监听器：它接受一个具体的本机 IPv4 或 IPv6 地址，绝不接受通配地址。未启用 TLS 的非 loopback 监听器以明文 HTTP 服务并在启动时告警，即使前面有 HTTPS `--public-url`。Host/Origin 栅栏接受 bind IP 本身；其他非 loopback authority 需要 `--trusted-host`，因此远端浏览器要么经由剥离前缀的代理访问 GUI，要么通过以可信主机名呈现的端口转发客户端访问。启动令牌交换与签名会话 cookie 对每个 API 方法和 WebSocket 流进行认证。

同时传入 `--tls-cert` 与 `--tls-key`，监听器便以 HTTPS 而非明文 HTTP 提供服务。两者各指定一个相对进程工作目录解析的文件：证书文件包含完整证书链，密钥文件为不带口令的 PEM 私钥。它们属于同一个设置——只提供一个会报用法错误，两个都不提供则保持明文 HTTP 默认值。文件缺失、不可读、为空，或不是有效的证书与密钥对时启动失败；绝不回退到 HTTP。监听器运行期间不会重新读取这些材料，因此更换证书需要重新加载监听器或重启进程。DSH 不签发、不续期也不监视任何证书：没有 ACME 客户端、没有自签名兜底，也没有重定向监听器。浏览器使用自己的信任库与主机名匹配，因此浏览器不信任的证书，或其 subject alternative name 未覆盖你所访问 authority 的证书，会在页面加载前失败。默认端口仍为 3080，且 `--tls-cert`/`--tls-key` 不跟随 `--public-url`：监听器的证书覆盖浏览器实际访问的 authority。TLS 不改变授权模型：Connection 仍认证每个请求并仍校验 Host/Origin，且只要接收请求的监听器提供 HTTPS，它所签发的会话 cookie 就带 `Secure`。

容器可以绑定其 Pod 地址并公告前置的入口：

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` 可能列出多个地址；`--host` 只接受一个，因此该命令取第一个。`fe80::1%eth0` 这样的 zone ID 不能出现在 URL 中，所以公告根会丢弃冗余的 loopback zone，而非 loopback 的 zone 需要显式 `--public-url`。没有 `--public-url` 时，`::ffff:127.0.0.1` 这类 IPv6-mapped loopback bind 公告其 IPv4 形式 `127.0.0.1`，让浏览器识别为本地可信源；点分四段 IPv6 尾段按 `listen` 的解读命名该地址自己的低 32 位，因此 `::0.0.0.1` 是 IPv6 loopback、公告为 `[::1]`，而 `::127.0.0.1` 是非 loopback 地址，不是 IPv4 loopback。

`--public-url` 公告浏览器使用的 HTTP(S) 根——打印与打开的启动 URL、`DSH_WEB_URL` 与 agent 运行时上下文中的 Web GUI URL。公告不授予任何信任：浏览器可见的 authority 还必须用 `--trusted-host` 点名。该 flag 不配置监听器、路由或 cookie 作用域，因为外部链路归代理所有：[在反向代理之后发布 Web UI](../../../docs/user/guide/public-deployments.zh.md)列出了这样的部署必须提供什么。`publicUrl` 配置字段发布同样的公告。

公告 URL 与浏览器信任栅栏都不保护端口本身，因此应把端口限制在可信代理或网络内。打印的 URL 包含进程凭据，只应与预期用户分享；`printUrl: false` 无论是否配置 `--public-url` 都会抑制该行。

<a id="model-retry-defaults"></a>
## 模型重试默认值

Web 使用共享的有界 normal 默认值，在首次请求后最多再重试五次符合条件的失败。`deepseek-official` 与由 settings 新增的 pi-ai 路由在省略 `retryPolicy` 时使用该默认值；显式提供方策略仍然优先。Web 不再增加重试专用的组合覆盖，因此非 Web profile 的省略行为与之相同。

<a id="invariants"></a>
## 不变量

**运行时不变量：** 未发布配套入口。补丁层插入 host 与 client 行，其插件各自拥有自身关系；web-runtime 粘合层只解析静态入口点，不持有可观测状态。


<a id="model-experience"></a>
## 模型体验

### Web 运行时变量

#### 模型看到什么

当 `surfaceContext` 为 true 时，`DSH_WEB_URL` 连同描述出现在受管 bash 环境中，每次调用时解析为上文「监听、信任与公开部署」定义的公告应用 URL。为 false 时不注册该变量。GUI 定位、实现 checkout 与当前 GUI URL 由本 bundle 挂载的 [`dsh-harness-dev-context`](../../context/harness-dev-context/README.zh.md) 行提供。

#### Token 影响

两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

无；该插件不贡献系统提示词文本。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **TLS 需自行启用且不代管**：只有传入 `--tls-cert` 与 `--tls-key`（完整证书链与不带口令的密钥）时监听器才提供 HTTPS；DSH 从不获取、续期或监视证书，更换文件需要重新加载监听器或重启进程。浏览器必须信任该证书，其名称必须覆盖你所访问的 authority，且证书与 `--public-url` 相互独立。
- **未启用 TLS 时外部链路是明文 HTTP**：请用终止 TLS 的代理保护它，不要在不受信任的网络上发送启动 URL。
- **只观测交接启动**：平台 opener 接受 spawn 后即结束观察，但 Windows 会等待其短生命周期 PowerShell launcher 退出；之后的浏览器退出不会上报，已打印 URL 仍是手动访问的回退路径。
- **SSH 转发持有浏览器 URL**：没有公告根时，打印的 URL 指向远端宿主机的 bind 地址端点（loopback bind 时为 loopback）；自动交接会被跳过，SSH 客户端或编辑器必须暴露并打开其本地转发地址。
- **不支持绑定所有网络接口**：通配 `--host`（包括 Linux 读取为 IPv4 any 的 IPv4-mapped 形式）在启动时因安全原因被拒绝；应绑定本机接口的一个具体 IPv4 或 IPv6 地址。
- **浏览器命令覆盖只能来自启动环境**：被发现的 `.env` 不得设置 `BROWSER`；只有继承值可以抵达会读取该变量的 opener 路径，避免 checkout 为自动交接选择可执行文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
