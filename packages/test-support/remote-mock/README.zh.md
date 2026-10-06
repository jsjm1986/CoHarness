---
description: "按端点命名的客户端线路流量 mock：一元应答与流脚本表、实时流控制、调用日志，以及 Connection 的 api/rpc 载体面，供测试作者在没有 Host 的情况下启动真实浏览器客户端。"
kind: "package-library"
---

# @deepseek-ai/dsh-remote-mock

[English](README.md) | 中文

## 概述

`dsh-remote-mock` 让测试通过 `mock.remote.<namespace>.<method>` 以原生 Vitest mock 方法配置 Host 应答。同一组函数同时应答直接调用与真实 Connection 流量；可复用的表提供默认应答，显式声明的流支持测试驱动的帧与取消。缺失的应答会让调用失败，并在拆卸时由 `assertNoUnmatched()` 再次报告。`mock.rpc` 是 `ClientConnectionRpc` 面，`mock.api` 是 `IApiClient` 面，全量客户端规格通过 `ClientTransportHooks` 把它们交给 `installConnection`；`mock.transports` 提供账户偏好与项目模型设置的传输句柄。该包无需业务 Host 即可运行，仅从 `devDependencies` 消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

当规格启动与 `ctx.remote` 对话的真实客户端插件、并希望按端点名称编排 Host 侧时使用：全量客户端规格把 `mock.api` / `mock.rpc` / `mock.transports` 交给 Connection 安装器，单元规格则可直接调用 `mock.remote`、`dispatch` 或 `open`。Gateway Remote 端点使用线路名（`session/page`、`settings/describe`）；手写 API 域暴露客户端方法名（`sessions.list`、`settings.describe`、`events.mux`）；`args` 是调用方的位置参数列表并去掉末尾的 `AbortSignal`；值是测试注册的内容并按原样应答。唯一的声明是端点是一元（`unary`）还是流（`stream`）。

<a id="remote-proxy"></a>
### 使用 Remote 代理

`mock.remote` 暴露所有命名空间与方法，无需方法清单或特定域辅助函数。每个被访问的端点使用缓存的原生 Vitest mock；`@vitest/spy.fn` 是 `vi.fn` 背后的实现，在没有 Vitest runner 的浏览器页面中同样可用。同一 mock 应答直接调用与 Connection 流量，因此返回值覆写与调用断言观察的是客户端实际调用的函数：

```text
const mock = RemoteMock.create().load(remoteDefaultResponses)
mock.remote.settings.describe.mockResolvedValue(ok({
  writable: true, hasDocument: false, namespaces: [],
}))
mock.remote.settings.mutate.mockResolvedValueOnce(ok(updatedNamespace))
// After the client writes:
expect(mock.remote.settings.mutate).toHaveBeenCalledWith('locale', operations, revision)
```

持久应答用 `mockResolvedValue`，排队应答用 `mockResolvedValueOnce` 或 `mockReturnValueOnce`，依赖参数的行为用 `mockImplementation`。原生排队应答按注册顺序消费，之后由 mock 当前实现应答。其初始实现读取已注册的默认值。`mockClear()` 保留应答与队列；`mockReset()` 清除覆写并恢复初始实现，该实现读取最新默认值。排队应答耗尽后缺失的默认值仍会失败，包括直接调用，后者可能同步抛错。

只有显式的 `stream()` 或表中的流声明才选择流方法；其余一律使用一元 mock。访问一个方法并不会凭空造出成功的业务结果。在保留方法引用前先声明流模式：每个端点/模式各自拥有自己的 mock。命名空间与方法的 `then` 探测和 symbol 读取是惰性的。

`MockedRemote` 对整个生成的 `TypertRemoteNamespaceMap` 应用 Vitest 深度 mock 变换。非空映射保留其命名空间与方法名、参数、结果及原生 spy 类型。空映射仅让该测试代理成为 `any`，允许任意命名空间与方法；它不会增补或削弱生产 Remote 声明。不需要复制方法签名、对生成模块的抑制或编译器级开关。交付 Remote/mock 变更前先运行 `pnpm run typecheck` 生成并检查真实客户端类型；缺失、过期或部分声明需要先重建。未构建时的测试成功或 `any` 推断不是严格的类型证据。

### 注册默认应答

`load(table)` 安装可复用的 `unary` 值或处理函数、`stream` 脚本以及无脚本的 `streams` 声明。`unary(endpoint, value)` 与 `unary(endpoint, fn)` 注册单个默认值；处理函数接收调用方的位置参数并使用既有请求类型。每个端点只保留最新的默认值，包括显式的 `undefined`；更新默认值不会丢弃原生覆写。`ok(value)` 构造 `{ ok: true, value }`；失败使用 `{ ok: false, error: { code, message, details } }`。有状态的处理函数、Promise 与原生队列保持在每个测试局部：

```text
const initial = { writable: true, hasDocument: false, namespaces: [] }
const mock = RemoteMock.create().load({
  unary: { 'settings/describe': ok(initial) },
})
mock.remote.settings.describe.mockResolvedValueOnce(ok({ ...initial, hasDocument: true }))
```

### 驱动流

流脚本是一个以打开时的 `args` 与 `StreamHandle`（`push`、`end`、`fail(error)`、`signal`）为参数的函数；脚本返回后流保持打开，直到句柄结束或失败它。`frames(items)` 构造产出这些条目后结束的脚本；`openStream(initial)` 构造产出后保持打开的脚本。`mock.streams` 控制客户端当前持有打开的流，可按打开时的 args 过滤；`opened(endpoint, count)` 在该端点被打开到指定次数时兑现，`drained(endpoint)` 在每个匹配流的消费者取完当前已推送的全部内容时兑现——打开的流其消费者等待更多、已完结的流其队列清空（从队列取出；只有消费者在读取循环内处理条目时它才等于已处理）：

```text
mock.stream('session/follow', openStream([snapshotFrame]))
await mock.streams.opened('session/follow', 1)
mock.streams.push('session/follow', eventFrame, ([request]) => (request as { sessionId: string }).sessionId === SID)
mock.streams.fail('session/follow', new Error('gone'))
await mock.streams.drained('session/follow')
```

失败的流让消费者的下一次读取以给定的 `Error` 拒绝。消费者取消（打开时的 signal 或迭代器的提前 `return()`）会中止 `StreamHandle.signal`，迭代无抛出地结束，并把该流记为 `cancelled`。本地生成的流方法返回普通的 `AsyncIterable`，因此该载体上没有客户端到主机的上行通道。

代替生成流方法的桩返回一个 `AsyncIterable`——这已是生成签名本身，不需要句柄包装。`streamMethod<M>(generator)` 把为该方法参数编写的异步生成器函数提升为方法自身签名，供 `vi.fn<M>()` 与 `mockImplementation` 使用。

### 连接客户端

`mock.api` 是 `IApiClient` 面，`mock.rpc` 是 `ClientConnectionRpc` 面（一元用 `call`，打开流用 `stream`）。把 `{ api: mock.api, rpc: mock.rpc, ...mock.transports }` 交给 `installConnection`——或由 `TestClient` 绑定——使每个域调用到达 `dispatch`、每个生成流方法到达 `open`，中间没有信封。载荷携带 `{ args }`：全量客户端代理发送数组形式，Gateway 自身端点发送对象形式（作为一个位置参数交付）；signal 中止的调用以中止原因拒绝。`RemoteMock.create()` 应答启动期的 `host.describe` 读取（`host` 来自 `RemoteMockOptions.host`，默认 `/home/mock`），并保持 `events.mux` / `events.host` 打开，这正是组装后的客户端达到 `connected` 所需；规格可以像其他规则一样覆写或失败其中任何一个。

### 观察与断言

`mock.log.calls(endpoint?)` 列出经 `dispatch` 或 `rpc.call` 的一元调用（`args`、`seq`、实时的 `pending` / `answered` / `failed` `state`，以及作为 `result` 的应答或抛出的错误）；`streams(endpoint?)` 列出脚本化打开及其实时 `state` 与 `pushed` 计数；`requests(endpoint?)` 按顺序列出调用与打开的第一个位置参数（不带端点时排除 `$` 前缀内部端点以及连接泵自身的 `events.mux` / `events.host` 打开）；`unmatched()` 列出未命中规则的请求。原生 `.mock.calls` 还包含直接代理调用；载体流 mock 收到最终的取消 signal。`assertNoUnmatched()` 在拆卸时报告漏报。`modeOf(endpoint)` 报告显式注册；`endpoints()` 还包含已访问的代理方法，供组装层提供其命名空间。

### 可能出什么问题

- **请求没有规则** —— `dispatch` 拒绝、`open` 抛出 `remote-mock: no rule for <endpoint>; registered: …`，日志记录该漏报；请注册该端点。
- **载荷不是 `{ args: unknown[] | object }`** —— `rpc.call` 拒绝、`rpc.stream` 抛出 `TypeError`；全量客户端代理发送数组形式、Gateway 自身端点发送对象形式，因此是手写调用有错。
- **同一流上的第二次并发读取** —— 读取拒绝；Gateway 顺序读取流，因此这指明测试侧误用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

### 设计

`dispatch` 与 `open` 接收端点与位置参数；`api` 通过 `IApiClient` 域名暴露同一核心，`rpc` 通过 Connection 的解码载体面暴露。每个 mock 拥有自己的原生函数与排队覆写；共享表提供默认值而不复制处理函数或应答对象。每个脚本化流拥有自己的队列、单个待决读取与日志条目；`end`、`fail` 或消费者取消中先发生的一个使其完结。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 公开面再导出 |
| [`src/remote-mock.ts`](src/remote-mock.ts) | `RemoteMock`：默认应答、原生 mock、Connection 分发、受控流与缺失应答检查；`ok` |
| [`src/remote-proxy.ts`](src/remote-proxy.ts) | 命名空间/方法查找与生成映射的 mock 类型 |
| [`src/api-client.ts`](src/api-client.ts) | `IApiClient` 外观：对照 `RpcMethodMap` 检查的域/方法名表、`events.mux` / `events.host` 读取器、`respond` |
| [`src/streams.ts`](src/streams.ts) | `frames` / `openStream` 脚本、`streamHandle` / `streamMethod` 桩类型、`MockStream`（句柄 + `AsyncIterable`） |
| [`src/log.ts`](src/log.ts) | 带共享 `seq` 计数器的日志存储 |
| [`src/transports.ts`](src/transports.ts) | `MockAccountPreferences` / `MockProjectModelSettings` 种子传输 |
| — | 不发布运行时不变量伴随物；此测试支持库不拥有生产事件流或可变的进程状态，其行为由其包测试覆盖。 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧测试基础设施；此处没有任何内容到达模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅进程内载体** —— `rpc` 服务于同一 realm 中的 Connection 实例；不为浏览器通道规格提供 HTTP 或 WebSocket 载体。
- **值按引用穿越** —— 应答与下行条目不经序列化到达客户端，因此真实线路会拒绝的非 JSON 下行值会原样通过。
- **不检查值** —— 一元应答必须是调用方读取的结果（`{ ok, value }` 或 `{ ok: false, error }`）；mock 原样传递且不检查这些字段。
- **无载荷匹配** —— 规则仅按端点匹配；在处理函数内按业务参数区分。
- **原生流覆写拥有自己的 iterable** —— 返回自有 iterable 的覆写绕过脚本化流日志、`requests`、`opened`、`drained` 以及 `push` / `end` / `fail`；调用方也拥有取消。原生调用断言仍然有效。需要这些控制的场景请使用注册的流脚本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
