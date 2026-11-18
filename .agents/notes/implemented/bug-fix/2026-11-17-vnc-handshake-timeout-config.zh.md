# Agent Note: VNC 受管握手预算移入 Config 以便测试扩展

状态： 已实现

[English](2026-11-17-vnc-handshake-timeout-config.md) | 中文

## 问题

`managedHandshake` 持有硬编码的 `HANDSHAKE_TIMEOUT_MS = 15_000` 作为凭证托管 RFB 协商的预算——这是一个随部署变化的可调值，违反了"插件内无硬编码 tunable"的规则，测试也无法注入。在覆盖率插桩的自托管 Windows 通道上，`splices a credential-managed stream and drops view-level input` 连续两次超时：回环握手只有数次进程内 socket 交换，但并发 fork worker 把事件循环饿过了 15s 墙钟，内部计时器先触发，而测试自身的 15s 上限使任何宽松化都不可能。

## 决策

`Config` 新增 `handshakeTimeoutMs`（默认 `15_000`，与 `probeTimeoutMs`、`attachTokenTtlMs` 同族）,`VncRemoteDesktop` 把 `this.config.handshakeTimeoutMs` 透传给 `managedHandshake`，后者以可选参数接受并默认沿用原常量。失败的 spec 现在传 `handshakeTimeoutMs: 60_000` 并把自身上限同步提高，使通道预算反映 CI 负载而非产品的线协议预期。

## 影响

- 握手预算与该 provider 其他超时一样可按部署配置；字段可选且默认不变，无消费者改动。
- spec 的回环握手能容忍被饿的 CI 事件循环，而不削弱产品对真实网络的失败检测。
- 反复出现的 CI 签名转化为由同一真实组合 spec 验证的配置项，而非靠重跑碰运气。

## 已考虑的替代方案

- 只提高测试的 vitest 超时——否决：内部 `HANDSHAKE_TIMEOUT_MS` 先于测试上限触发，加大测试预算毫无作用。
- 提高模块常量——否决：这会把每个部署的真实网络失败检测延迟翻倍，只为掩盖测试环境的调度产物。
- 按重跑 flake 处理——否决：该签名已在连续两轮 windows-native 复现；回环预算不应依赖 runner 运气。

## 验证

- `packages/remote-desktop/remote-desktop-vnc` 套件——本地 59/59，含重新调整预算的 `splices a credential-managed stream` spec。
