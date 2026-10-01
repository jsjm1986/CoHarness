# Agent Note: Browser-session authentication for the Web Connection carrier

Status: implemented

[English](2026-10-01-browser-auth-web-transport.md) | 中文

## Problem

`dsh web` 的 index 与全部 `/api` 通道由同一个 HTTP 监听提供，默认仅 loopback，在 `--trusted-host` 下对 LAN 可达。此前准入只有 `api-request-trust.ts` 的 Host/Origin DNS-rebinding 围栏——其自身注释明确声明它不是认证：能到达端口的任何进程都能驱动会话、工作区文件与网关操作。上游 `dsh-v0.2.0-rc.1` 携带 `packages/client/connection/src/browser-auth.ts`；本地分叉没有等价物。

## Decision

[BrowserAuth](../../../../packages/client/connection/src/browser-auth.ts) 以启动令牌交换加持久签名 cookie 认证浏览器侧载体。

`Connection.authenticatedUrl(base)` 是浏览器直连入口：`web-app` 把它作为启动 URL 打印，内嵌保存在 `WeakMap` 中的每进程随机启动令牌。index 属主——发布组合的 `frontend-static`，或没有它的组合里的 `connection.authorizeIndex`——把 `?token` 换成 `303` 并设置 `dsh-auth-<sha256(authority)>`，载荷 `{version, authority, issuedAt, expiresAt}` 由持久在 credentials 服务中的密钥做 HMAC 签名（`client-connection/browser-session`，版本化 grant 记录）。cookie 为 `HttpOnly; SameSite=Strict`，按规范请求 authority 命名，同一监听服务多个 authority 时不会跨 authority 重放。

`HostConnectionService.requestRejection` 感知子树。声明 `authority: 'loopback'` 的注册与拦截器端点保持 loopback 围栏作为完整准入——webhook、archive 网关等机器调用方无法执行浏览器令牌交换。没有 provider 应答时，其余 `/api` 子树、通用 RPC 通道与 upgrade 请求都要求有效 cookie（`401`），信任围栏仍先行（`403`）。

在围栏与 Cookie 检查之间有一个通用准入点：`connection/authenticate(request)`，同步事件，声明为 `@mode bail`，经 `ctx.bail` 求值——第一个已定义应答生效，`undefined` 表示不下结论。裁决用词是字面量对 `'allow'`/`'deny'` 而非布尔值，因为 Cordis 的 bail 无法承载 `false`：`'allow'` 不铸 Cookie 即放行，`'deny'` 即使存在已签发 Cookie 或存活启动令牌也拒绝。`connection.authorizeIndex` 以相同方式询问它，provider 放行仍须通过 Host/Origin 围栏。provider 必须自行验证身份——看到请求头绝不是放行依据——其注册保持效应作用域，随 provider fiber 一并销毁。GatewayRuntime 挂载了已发布的 provider：其签名的 `x-dsh-gateway-principal` 断言在无需浏览器 Cookie 的情况下放行 index、`/api` 子树、通用通道与事件流，而任何受限用途的断言都被约束在其声明的 HTTP 操作上，绝不能提供 index 或开启事件流。principal 的再次校验、用途限制与 AsyncLocalStorage 传播仍留在 `connection/request` waterfall 中——provider 只裁决准入。

`apply` 变为异步，因为 `BrowserAuth.create` 要等待凭证记录。Web 服务器注册下沉进 `ctx.inject(['webServer'], ...)`，非 Web 组合只保留 RPC 注册表而无需 HTTP 面。测试与脚手架助手经 `authorizeIndex` 在进程内铸 cookie；Node 侧 `hostFetch` 显式附带。

## Alternatives considered

**只保留信任围栏作为唯一准入。** 围栏能挡 DNS rebinding，但 `--trusted-host` 打开监听后挡不住 LAN 对端或信任列表之外的本地进程调用 `/api`。会话与文件系统授权需要真正的凭证，而不是可达性。

**loopback 完全豁免。** 上游对一切 `/api` 请求（含 loopback）要求 cookie，否则其他本地进程可伪造请求再由浏览器授权。本地的非浏览器 loopback 调用方只走 `authority: 'loopback'` 子树并保留各自围栏；普通 `/api` 在所有接口上保持认证。

**持久化启动令牌或接受存储密码。** WeakMap 启动令牌不跨进程存活，泄露的 URL 在进程退出即失效，也不存在需要用户轮换的凭证。持久签名密钥为随机生成，不由操作者提供。

**只认证 `/api` 不认证 index。** 不认证地提供外壳仍需 cookie 才能发起任何有效调用，因此 index 采用同一认证，一次交换覆盖两者。

**在 Connection 内对 Gateway principal 请求头特判。** 按请求头名分支会把通用载体与某一种部署耦合，并诱使“见到了请求头”充当验证。三态 provider 事件让 Connection 保持部署中立，由运行时自行证明签名、过期、scope 与目标——包括可否决有效 Cookie 的 `'deny'` 应答。

## Consequences

所有浏览器 e2e 与 profile 测试现在执行令牌交换或附带铸好的 cookie；未认证的 `/api` 消费方必须声明 `authority: 'loopback'` 或经 `authorizeIndex` 获取 cookie。轮换凭证记录会使已发 cookie 全部失效。启动令牌不落日志不落盘，重启后把打印 URL 拷到别的浏览器会失败关闭。挂载 GatewayRuntime 时，provider 对一切缺少有效断言的请求应答 `'deny'`，因此仅有启动令牌 URL 或已签发 Cookie 会得到 401——代理签发的 principal 是该运行时唯一接受的浏览器凭据，销毁 provider 则恢复浏览器直连流程。

## Testing

`packages/client/connection/tests/browser-auth.host.spec.ts` 钉住令牌交换、cookie 作用域、过期、密钥持久、拒绝路径以及 provider 放行/拒绝相对二者的优先级；`node-half.host.spec.ts` 演练携 cookie 传输以及 provider 事件的围栏顺序与销毁。Web profile 测试对真实启动做交换并断言打印 URL 携带令牌。没有 `frontend-static` 的 real-composition 测试在进程内铸 cookie。`packages/context/gateway-runtime/tests/gateway-admission.host.spec.ts` 启动部署组合——真实的 Connection、Web 服务器、frontend-static 与 GatewayRuntime——证明签名 principal 下 index、`/api`、通用通道与 WebSocket 的放行，以及每一条拒绝路径。
