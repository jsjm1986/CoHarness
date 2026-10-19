# Agent Note：Operator 连接按请求声明交互模式并绑定到请求作用域

状态：implemented

[English](2026-10-18-operator-connection-interactions.md) | 中文

## 问题

上游 rc.2 为非页面/程序化客户端提供了连接运行中 Host 的方式：launch token 交换铸造一个携带 `interactions` 模式（`'none'` 或 `'answer'`）的 `Peer`，`'none'` 的 Peer 从不打开 `$events` 循环，也无法回答交互。fork 有相同的产品需求——operator 进程（CI、脚本、ACP 式自动化）必须在没有浏览器 cookie 的情况下到达存活 Host——但没有相应机制：没有 `Peer`、没有 operator cookie 铸造、没有 `$events` 流。fork 通过 `rejectionFor` 独立认证每个请求，在一条 mux 下行通道上把交互帧与普通帧复用，并已通过 `CollaborationAuthority.claimInteraction` 原子地认领交互。

## 决策

**交互模式按请求声明，而不是绑定到铸造的凭证上。** `ConnectionInteractions = 'none' | 'answer'` 位于 `packages/host/apiproxy/src/api/interactions.ts`——一个零依赖契约文件，携带该类型、`x-dsh-interactions` 头 / `?interactions=` 查询名、严格解析器与 `interactionsUnavailableError()`。每个客户端 URL 声明解析出的模式；`ConnectionRequestBoundary` 新增 `url`，使声明在无头载体上可见（WebSocket 构造器不接受自定义头）。

**launch token 通过既有回退路径兼任 operator 凭证。** `rejectionFor` 仍先运行信任围栏与 `connection/authenticate` provider 决断；当 provider 返回 `undefined` 时，`browserAuth.operatorInteractions(url)` 读取 `Authorization: Bearer <token>` 或 `?token=` 及声明的模式。凭证存在且有效、模式合法时放行；凭证存在但 token 无效或模式畸形时以 401 拒绝——operator 凭证绝不借 cookie 回退路洗白。其后的浏览器 cookie 路径不变。把该检查放在 `BrowserAuth` 回退内部——而非 `connection/authenticate` 监听器——保持了 provider 的优先级：若某个 composition 监听器先于 `gateway-runtime` 回答 `'allow'`，会绕过强制性的 gateway-principal 策略。

**准入把模式绑定进 AsyncLocalStorage 请求作用域。** connection 插件注册一个 `connection/request` waterfall 监听器（与 `gateway-runtime` 绑定每请求 principal 用的是同一 seam）调用 `bindRequestInteractions`。解析顺序：合法声明模式优先；否则 token 准入的 operator 默认 `'none'`；否则 `'answer'`。未绑定的作用域——进程内分发、内部调用——读作 `'answer'`，因此历史路径不会自我降权。

**服务端门控截留交互流量，而不是断开连接。** `events.mux` 在订阅时捕获作用域：发布循环丢弃 `approval/requested`/`approval/resolved`/`question/requested`/`question/resolved` 四种帧，初始重放对 `'none'` 跳过待决 approval/question。`events.host` 从不注册 `API_REMOTE_FORWARDED_EVENTS` 监听器，因此 `'none'` 订阅者不会产出任何 `host/remote-event` 帧。`respond` 在注册表查询之前对 `'none'` 返回 `{ accepted: false, reason: 'not-pending' }`——对一个从未被展示该交互的请求方而言这是诚实的回执。同一 socket 上的普通 session、queue、jobs、workspace 帧继续流动：`'none'` 是观察降权，不是断连。

**客户端助手按解析出的模式快速失败。** `installConnection` 解析 `options.interactions ?? (location === undefined ? 'none' : 'answer')`——与上游规则一致——并暴露到 `ConnectionHandle.interactions`；`ClientTransportHooks.createApiClient` 收到该值，使 transport 遵守单一来源。`AbstractApiClient.respond` 在任何网络调用之前抛出稳定的 `interaction participation is unavailable on a 'none' connection` 错误，覆盖 `PendingWait.respond` 与手写调用方。`ClientRemoteService.$on` 在订阅前抛出同一错误。`$stream` 保持不门控：它监督 Remote 读流，而 `'none'` 必须保留读流。Session 帧处理还在 API 客户端绑定 `'none'` 时跳过铸造 approval/question `PendingWait`，使陈旧或被过滤的帧永远无法武装回答路径。

**`createOperatorTransport(baseUrl, token)` 是程序化入口。** 它返回 `ClientTransportHooks`，其 API 客户端、socket 工厂与 generic-RPC fetcher 把每个请求重定向到 `baseUrl` 并附加 `token` 与 `interactions` 查询参数。在非页面上下文调用 `installConnection(ctx, { transport: createOperatorTransport(...) })` 默认 `'none'`；传 `interactions: 'answer'` 则在同一原子认领路径下授予完整参与——竞争仍由 `claimInteraction` 裁决，第二个认领者收到 `not-pending`。

## 已考虑的替代方案

**移植上游的 `/connect` 交换 + Peer cookie。** 否决：铸造会话凭证重复了按请求认证已有的职能，引入 fork 本不持有的生命周期状态，且 browser-auth Agent Note 已把 cookie 铸造限制在 index 交换上。

**用 `connection/authenticate` provider 对 launch token 回答 allow。** 否决：决断事件的第一个有定义答案会整体取代浏览器认证，且监听器顺序取决于 composition；过早的 `'allow'` 会让 launch token 越过 gateway-principal 策略。把检查嵌入既有回退保持每个 provider 的 `'deny'` 依然拒绝。

**像上游缺失 `$events` 那样完全拒绝 `'none'` 下行通道。** 否决：fork 的 mux 同时承载 operator 合法观察的与一元 RPC 相邻的 session 流量；只截留交互帧既保留可观察运行又遵守契约。

## 影响

页面安装除 api URL 携带 `?interactions=answer` 外逐字节一致——准入绑定声明的模式，行为不变。`'none'` 连接保留一元 RPC、原始流、mux 与 host 下行通道（减去交互帧）；它无法观察或回答 approval、question 或转发的交互事件，其客户端助手在到达网络层之前抛出。无效 launch token 与畸形模式声明在准入处返回 401。

回归覆盖位于 `packages/client/connection/tests/interactions.client.spec.ts`（默认值、operator URL 装饰、fixture 一致性）、`packages/host/apiproxy/tests/api-proxy-interactions.spec.ts`（mux/重放/remote-event 过滤、respond 拒绝、双方原子竞争、未绑定回退）、`packages/api/gateway/tests/gateway.client.spec.ts`（`$on` 门控、一元调用保留）与 `packages/client/connection/tests/node-half.host.spec.ts`（operator 准入与 401 用例）。设计映射：上游 `interactions` 模式映射为连接声明的模式，上游 `claimInteraction` 映射为 `collaboration.authorize` 上的同名原子认领，上游 `/connect` 令牌交换映射为 fork 自有 authenticate 接缝上的启动令牌准入。
