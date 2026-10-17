---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

Web HTTP 与 upgrade route 注册插件（默认导出 `WebServer`，配置为 `{host, port, tls?, compression?, compressionLevel?, compressionThresholdBytes?}`）：一个在激活时开始监听的 `node:http` 服务器——当 `tls` 指定证书与私钥时改用 `node:https`——提供 `ctx.webServer`。`register(route)` 添加具名的 `exact`／`prefix` HTTP route；`registerUpgrade(route)` 添加精确 pathname 的 upgrade route；同一张表内的重复路径会抛错，因为 route 模式是组合层约定，冲突即配置错误；两者返回的 disposer 都会移除注册。`registerFallback(handler)` 注册一个 handler，处理所有未被具名 route 命中的请求。第二次注册会抛错；随附的 SPA dist 服务器 [`dsh-host-frontend-static`](../frontend-static/README.zh.md) 是该 handler 的所有者，没有注册 handler 时服务器返回 404。`tapIndex(transform)` 添加一个 index.html 转换，`applyIndexTaps(html)` 按注册顺序对一段响应体运行已注册的转换；fallback handler 在每次 index 响应时调用它。 `renderIndexInjections()` 会在结构化行之后追加一个小型 `__DSH_BOOT_READY__` 尾部；直接提供的页面立即 resolve 它，preview bootstrap 则可以在握手后结算同一个 deferred。`AppWebEntry` 在读取注入的启动状态前等待这个可选信号。`port` 读取正在监听的端口（当 `port` 为 0 时读取 OS 分配的值，绑定前为 `undefined`），`host` 读取配置的绑定宿主，`protocol` 读取所绑定监听的 `'http:'` 或 `'https:'`，`getOrigin()` 读取本机客户端访问的根 URL（这些是其他插件据以自适应的组合期事实，例如会话 Cookie 的 `Secure` 属性或 directory-picker 选择器）。HTTP 匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后交给 fallback handler。upgrade 只做精确匹配，未命中连接直接关闭；注册顺序不影响请求处理。

`compression: 'gzip'` 会包装基于 socket 的 HTTP 响应，而不改变 route API。客户端必须偏好 gzip，且媒体类型必须可压缩；已知长度低于 `compressionThresholdBytes` 的响应保持 identity，未知长度的 stream 则直接具备压缩资格。`compressionLevel` 控制 DEFLATE 强度。已有内容编码、`Cache-Control: no-transform`、范围响应、SSE、ZIP 与打包后的 `.gz` Worker 镜像均保持原样。随附的 Web 组合启用 level 1 和 1024 字节阈值；其他组合默认使用 `compression: 'none'`。Web Worker 隧道不携带浏览器管理的 `Accept-Encoding` 请求头，因此其合成响应仍为 identity 字节。

该包不了解任何 harness 概念，也不提供任何文件服务：`/api` HTTP 桥接与下行 WebSocket 是 connection 插件的 route，插件 bundle 与 HMR（热模块替换）事件流是 modules／hmr 插件的 route，dist 服务则属于 fallback 持有者。upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request。`host` 接受本机接口的一个具体 IPv4 或 IPv6 字面量——例如容器自身来自 `hostname -i` 的 Pod 地址。回环字面量（127/8 中任意地址、`::1`，或二者的 mapped 形式）让服务器留在本机；其他字面量会在该地址所属网络上提供 HTTP，除非设置 `tls`，否则为明文。未指定地址——包括 Linux 读取为 IPv4 any 的 IPv4-mapped 形式——会在加载时被拒绝，而不是在所有接口上同时开端口。`port` 0 请求操作系统分配端口；之后 `ctx.webServer.port` 读取监听端口，导出的 `isLoopbackHost(host)` 与 `isWildcardHost(host)` 按解析值对地址分类，因此 mapped 或带 zone 的拼写会按它命名的地址归类。点分四段 IPv6 尾段按 `listen` 的解读命名该地址自己的低 32 位，所以 `::0.0.0.1` 是回环 `::1`，而 `::127.0.0.1` 是非回环 `::7f00:1`；`normalizeBindAddress(host)` 返回该地址文本——真正的 mapped `::ffff:127.0.0.1` 得到 `127.0.0.1`，`::0.0.0.1` 与 `::1%lo` 都得到 `::1`——可直接作为 URL host。`bindUrlHost(host)` 把该文本写成 URL host（IPv6 加方括号），对 URL 无法携带的非回环带 zone 地址返回 `undefined`；`ctx.webServer.getOrigin()` 把它与协议、监听端口组合成本机客户端访问的根 URL，在端口绑定之前或没有 URL 形式时抛错。该服务器只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。该包从不打印内容；URL 行属于 shell。

`tls` 在同一地址上以 TLS 提供同一批路由：载体不会另开一个 HTTP 监听，也从不重定向。两个文件在激活期间、socket 绑定之前各读取一次，因此不可读、为空或格式错误的文件、与证书不匹配的私钥，或绑定失败都会拒绝初始化——配置错误的证书绝不会退回 HTTP。路径相对进程工作目录解析，私钥必须是无口令的 PEM，`certFile` 可以包含证书链且叶子证书在前。显式的 `tls: null` 会归一为未设置监听。替换任一文件都需要重新加载；本载体既不申请也不续期证书；客户端仍会校验你提供的证书，本载体不附带信任库、不做 HTTP 到 HTTPS 的重定向，也不发送 HSTS 头。

监听失败（EADDRINUSE……）会从激活过程抛出，并以绑定诊断信息拒绝 Loader 组合，不可用的 TLS 材料同样会拒绝它，诊断信息给出配置字段与解析后的路径，但绝不包含文件内容；失败的候选 fiber 会被 dispose（资源释放）。处理 HTTP 请求时抛错（例如 fallback 持有者的 `decodeURIComponent` 收到格式错误的百分号转义，或客户端在请求体传输中途断开）时，服务器会响应 400；若响应头已经发出，则销毁 socket，并记录 warning，但绝不会退出进程。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket 与所有原始 TLS 连接——Node 的 `closeAllConnections()` 只在握手完成后才纳入 TLS socket——并仅在 HTTP server 与这些 socket 均已关闭后返回。

`script-preload` 行在 head 中添加建议性的经典脚本预加载。URL 按 HTML 属性转义；该行不执行脚本，也不确认启动就绪，这些职责仍由有序的 `script-src` 行和末尾就绪脚本承担。

## 概述

浏览器经由 `dsh-host-webserver` 通过 HTTP 访问 web GUI：一个 `node:http` 服务器——当 `tls` 指定证书与私钥时改用 `node:https`——其他插件在其中注册具名路由、upgrade 路由、index 启动输入与一个回退 handler。它不了解任何 harness 概念，也不提供任何文件服务——`/api` 桥接、插件 bundle、HMR（热模块替换）事件流与 SPA dist 都属于注册它们的插件。路由匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后交给回退 handler。它只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无。该 HTTP 载体只桥接浏览器与 API handler，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **不管理证书生命周期**：`tls` 只提供激活时存在的 PEM 文件——载体从不申请、续期或监视它们，并采用 Node 默认的 TLS 策略。替换证书需要重新加载。
- **不提供服务器级认证或来源策略**：`dsh-client-connection` 等 route owner 会实施自己的请求策略。绑定非回环地址仍会向该网络公开未受保护的 route 与静态资源。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

两条工作备注，均非权威结论：

- TLS 测试材料在测试时生成（`tests/tls-fixture.ts`），绝不入库：GitHub push protection 会拦截测试中的 PEM 私钥，况且该证书本就是一次性的。该助手每个进程签发一张自签名的 localhost 证书，覆盖 127.0.0.1、`::1` 与 `localhost`，并以仅属主可读的权限写入私钥。
- `selfsigned` 固定在 4.x：在 pnpm 下 5.x 会装入两份 `@peculiar/asn1-schema`，其 extension 构造器随后会让每次 `generate()` 抛错。

</details>
