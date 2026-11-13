# Agent Note: 将签名 principal 的过期时间锚定到回拨后的签发时间

Status: implemented

[English](2026-11-13-windows-event-principal-expiry-anchor.md) | 中文

## 问题

`GatewayPrincipalSigner` 在 `win32` 上将 `issuedAt` 回拨一个 Windows 时钟刻度（16 ms)，以便即时投递的断言能经受住 V8 粗粒度系统时钟基线的重采样。但 `expiresAt` 锚定的是未调整的 `now`。因此在 Windows 上，每个已签名 principal 的声明寿命（`expiresAt - issuedAt`）都比预期寿命多出一个刻度；对于按 30 秒上限签发的[事件连接 principal](../architecture/2026-10-23-event-stream-principal-renewal.zh.md)，声明寿命读数为 30 016 ms。`StreamPrincipalLeases.register` 拒绝一切超过 30 000 ms 的断言，于是所有经过 Windows 托管 Gateway 的 `events.mux`/`events.host` 升级均被拒绝并销毁节点服务桥流，在中心侧表现为 `node-service/unavailable`(503)，而同一通道上的普通 HTTP 请求却完全正常。

## 决策

[principal.ts](../../../../gateway/src/principal.ts) 中的 `expiresAt` 现统一为 `issuedAt + lifetimeMs`，覆盖请求 principal 路径与 `issueForward`，使文档声明寿命在任何平台上都等于预期寿命。Windows 上绝对截止时间因此提前 16 ms——相对于 30 秒及更大的 TTL 属于可忽略的位移——且全部既有不变量（`issuedAt` 永不落在未来、`expiresAt` 永不已过期、声明寿命不超过注册上限）无需在检查器中引入平台分支即可成立。

## 已考虑的替代方案

**在 Windows 上将注册上限放宽一个刻度。** 否决：会把签发平台的时钟补偿泄漏进验证契约，且文档声明寿命仍与请求值不一致。

**仅收紧 `issueStream`。** 否决：锚定错误存在于每一条 `signPrincipal` 与 `issueForward` 签发路径；修复共享锚点一次性消除该类缺陷。

## 影响

经 Windows 托管 Gateway 的事件连接——包括每个远程节点的浏览器事件流——现在能够正常注册与代理。普通 principal 无任何损失：其有效寿命在 Windows 上最多缩短 16 ms。`issueForward` 同样采用锚定过期时间以保持一致，尽管目前没有检查消费该时长。

## 验证

`principal.spec.ts` 用平台感知的 `first` 时刻断言锚定过期时间与两个边界瞬时；更新后的 [run-windows-principal-clock.mjs](../../../../gateway/tests/run-windows-principal-clock.mjs) 在真实 Windows 上补充回归证明：`issueStream` 断言必须落在 30 秒注册窗口内，且必须能通过 `StreamPrincipalLeases` 注册。该缺陷在修改前已在 `windows-vps-47` 节点上实测复现（网桥 `ERR_STREAM_PREMATURE_CLOSE`,`event principal is not short-lived browser authority`)，修改后消除——升级 socket 返回 101，公网站点端到端拉起 Windows runtime。
