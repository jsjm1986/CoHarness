# Agent Note: 在本地校验经由代理的 web_fetch 主机名

Status: implemented

[English](2026-11-13-web-fetch-validates-proxied-hostnames.md) | 中文

## Problem

[出站代理策略](../architecture/2026-08-27-outbound-proxy-policy.zh.md)让经由代理的 `web_fetch` 一跳跳过 `resolvePublicAddresses()`：只有非公网 IP 字面量会被拒绝，主机名不经检查直接交给代理。设置了 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 后，受抓取内容操控的模型可以让代理访问 `metadata.google.internal` 或内网主机名，读取代理可达的任意 GET 服务。直连路径会拒绝同样的目的地。

## Decision

[provider.ts](../../../../packages/web/web-fetch-http/src/provider.ts) 在读取路由之前，先用提供方的解析器解析每一跳。非公网结果以 `WEB_BLOCKED_URL` 失败，无法解析的名字以提供方或网络错误失败，两种情况下代理都收不到请求。只有校验通过后，`proxyRouteFor(url)` 才选择传输：代理路由使用策略调度器调用 `requestVia`，直连路由照旧固定已校验的地址集。IP 字面量进入同一个解析器，无需 DNS 查询即被拒绝，因此移除了单独的 `isNonPublicIpLiteral` 检查。

## Alternatives considered

**继续信任代理进行目的地选择。** 否决：运维方设置代理是为了访问互联网，而不是把代理视角下的内网交给模型；直连路径已经定义了 `web_fetch` 可以到达哪些目的地。

**按后缀拒绝名字（`.internal`、`.local`、元数据主机）。** 不作为主要检查：后缀列表会漏掉任意内网主机名，而本地解析会拒绝每一个应答为非公网地址的名字，以及本机无法解析的每一个名字。

**把代理请求固定到已校验的地址。** 否决：undici 的 `fetch` 从 URL 推导 absolute-form 目标、`Host` 与 TLS SNI，把地址发给代理会破坏虚拟主机与证书校验。

**为仅代理可解析的名字提供允许列表。** 暂缓：当前没有消费方需要只有代理能解析的名字；增加它属于单独评审的配置。

## Consequences

经由代理的一跳获得与直连一跳相同的目的地策略。它会被校验但不固定地址，因此在本地查询与代理查询之间变化的 DNS 应答仍可能到达代理可路由的私网地址；包 README 记录了这一限制。本机无法自行解析公网名字、依赖代理做 DNS 的部署不再能通过 `web_fetch` 抓取。

## Verification

[proxy.spec.ts](../../../../packages/web/web-fetch-http/tests/proxy.spec.ts) 驱动一个真实的 loopback 代理：带有桩公网应答的主机名被解析一次并经隧道转发且不固定地址；应答为 `10.0.0.1`、`169.254.169.254` 或 `127.0.0.1` 的主机名在代理收到请求之前以 `WEB_BLOCKED_URL` 失败；没有应答的名字未到达代理即被拒绝；非公网字面量仍被拒绝；被绕过的一跳仍会解析并固定地址。
