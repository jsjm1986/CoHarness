# Agent Note: 远程桌面 stream URL 经身份钉住绑定文档的 runtime 目标

Status: implemented

[English](2026-10-20-remote-desktop-stream-url-runtime-pinning.md) | 中文

## Problem

`ClientRemoteDesktops.attach` 原先拼出的 WebSocket URL 是 `stream.path?token=`，只带一次性 token。Gateway 的 upgrade 处理器从 `dshTarget` 查询参数解析目标 runtime，没有则回退 `hgw_scope` cookie——而这个 URL 两者都没有。当 cookie 与发出 `attach` Remote 调用的 scope 不一致时（例如未经 scope 切换直接进入的项目 workspace），upgrade 被代理到 pending attachment 并不存在的 runtime：`serveStream` 销毁 socket 却不消费 token，浏览器画布保持空白，孤立的 pending attach 在 60 秒后过期——audit 的 `detach` 行恰好落后 `attach` 一个 `attachTokenTtlMs`。

## Decision

现在 attach 响应在交换协议前先把 path 过一遍 `connection.privateResourceUrl`。这个回调是 `BrowserIdentityFence.privateUrl` 在客户端的绑定，会给 `/api/*` URL 追加 `dshTarget`（文档钉住的 runtime）和 `dshPrincipal`（已验证账号 id）——与客户端内其他 socket 和私有 URL 所用的同一套 admission。钉住必须在 http(s) 形态上做，因为 fence 拿候选 URL 的 origin 与页面 origin 比较；`wss://` URL 会过不了该检查而原样返回，所以先钉住、再转成 `ws(s)://`。回调是可选的：没有 identity fence 时（独立 host、测试）模型回退到未钉住的 URL，保留原有行为而非失败。

## Alternatives considered

**服务端读 scope cookie 并信任它。** 否决：那正是坏掉的路径——cookie 跟随显式 scope 切换，而不是 Remote 调用被路由到的 runtime，二者无需用户操作就会不一致。

**让 stream 挂载在跨 runtime 上做 attach-token 查找。** 否决：pending attachment 本来就是按 runtime 隔离的状态；把查找扇出会让 provider 互相耦合、还会泄露 token 存在于哪个 runtime，而真正的缺陷是 upgrade 一开始就到错了 runtime。

**在 controller 的 `stream.path` 响应里直接盖 `dshTarget`。** 否决：provider 面向所有 transport 作答，不知道发起请求的文档解析到哪个 runtime；目标钉住是客户端文档自己的事，这正是它归 fence 管的原因。

## Verification

`packages/api/remote-desktop-controller/tests/client-model.client.spec.ts` 覆盖两个分支：替身 `privateResourceUrl` 产出带 `token`、`dshTarget`、`dshPrincipal` 的 `wss://` URL；没有回调时 URL 只保留 path 与 token。包内全部测试通过。线上复现精确呈现了故障形态：token 铸造在 personal runtime 时，按 `project:3` 发出的 upgrade 立刻以 `1006` 关闭，而 scope 正确的 upgrade 收到了真实端点的 `RFB 003.889` 横幅。

## Consequences

现在无论 `hgw_scope` cookie 是什么，upgrade 都会到达铸造 token 的 runtime，cookie 不匹配不再能搁浅 pending attach 把画布留白。今后这个模型新开任何 socket 都必须走同一个钉住调用——绕开它就会重新引入 cookie 依赖。`remote-desktop-controller` 的 client `inject` 现在包含 `connection`（web 组合必定提供）；没有它的组合仍能通过 `ctx.get` 回退正常工作。
