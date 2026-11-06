# Agent Note: 节点代理经可配置源站拨号连入 center，而 center URL 仍是身份

Status: implemented

[English](2026-11-06-node-agent-dial-paths.md) | 中文

## 问题

节点代理此前只有一种方式到达它的 center：`HGW_NODE_CENTER_URL`，它同时作为绑定进状态文件的凭证身份和每个控制请求、控制通道 WebSocket 以及每条服务流的拨号源站。最佳路由不是公网源站的运维场景——到回环的 SSH 反向隧道、LAN 地址、mesh 覆盖网络——无法在不重新绑定已保存凭证身份的前提下命名这条路由，而这种漂移会被有意地以 `center-identity-mismatch` 拒绝。

## 决策

`HGW_NODE_CENTER_DIAL_URLS` 持有一个逗号分隔的有序源站列表，所有源站都到达同一个 center；`HGW_NODE_CENTER_URL` 单独保留为状态文件绑定、enrollment 检查执行的身份。每一项按与 center URL 相同的源站规则校验——HTTPS，或仅回环上的 HTTP——空项、重复项与无效项在加载时以 `node-agent/invalid-dial-urls` 失败。未设置时列表恰为 `[centerUrl]`，这是唯一的隐式成员；显式列表不会被追加任何成员。

每次代理运行创建的一个 `NodeDialer` 实例（`gateway/src/node-dialer.ts`）为三个面向 center 的消费者各自的全新尝试选取源站：`/internal/nodes/*` 控制调用、控制通道的每次（重）连，以及每条服务流的打开——后两者经通道与桥接配置在打开时读取 `dialer.current()`。只有网络层失败才推进列表：fetch 拒绝、WebSocket 在 `open` 之前出错或关闭、握手超时。任何 HTTP 响应——包括 4xx/5xx 和带状态码被拒绝的升级——都说明已到达 center，不是回退触发；`unexpected-response` 被消费，使其保持为普通的拒绝。变化只影响下一次尝试：进行中的请求从不向另一源站重放，保留各调用方原有的不重放语义。`HGW_NODE_AGENT_DIAL_PREFERRED_RETRY_MS`（默认 60000，与其他节点计时器相同的正整数规则）负责回探候选 0：回退之后首个晚于该时长的全新尝试重新从首选源站开始。每次源站变化记录一条不带凭证的 `dial-origin` 事件及其原因码。节点访问语义不变，因为 center 仅按 bearer 加 connection/epoch 头在既有路由上认证节点流量，与拨号路径无关。本决定服务于 [proposed runtime-management note](../../proposed/architecture/2026-10-28-multi-computer-personal-runtimes.zh.md) 所述的多计算机传输。

## 已考虑的替代方案

**仅拨 center URL，由 DNS 或本地代理前置。** 否决：解析层的技巧对代理不可见，无法确定性回退，也破坏了凭证文件赖以诊断的同源保证。

**任何失败都回退，包括被拒绝的请求。** 否决：拒绝本身就是一次收到的 HTTP 响应——证明该源站能到达 center——对其回退会把已认证的拒绝错标为传输失败，还可能把身份敏感的操作重放到另一条路径。

**用独立定时器自动恢复首选候选。** 否决独立定时器：重试本就以各调用方自己的节奏发生，把回探绑定到窗口之后的下一次全新尝试，不需要额外 socket 也不需要单独的调度器。

## 后果

默认路径与旧行为逐字节一致：单候选、无回退、无可观察的新定时器。配置列表后，代理在首选路由失效时无需运维改动即可存活，代价是每次源站变化输出一行 `dial-origin`，以及回探窗口推迟返回首选路径。`NodeChannelClientConfig`/`NodeServiceBridgeConfig` 以共享拨号器取代 `centerUrl`——对构造它们的三个调用点是一次契约变化，全部位于本仓库内。

## 验证

`node-dialer.spec.ts` 覆盖失败推进、陈旧报告与末尾候选不变量，以及注入时钟下的首选回探。`node-agent.spec.ts` 新增列表/计时器校验矩阵、首选候选失效后经第二源站连入并记录变化的回退测试，以及在另一源站服务拨号列表时状态文件仍绑定 `centerUrl` 的测试。`node-service.spec.ts` 以 `[dead, base]` 驱动一条通道加一次代理服务流。`test:postgres` 覆盖不变：进程级 enrollment 仍走默认单源站路径。
