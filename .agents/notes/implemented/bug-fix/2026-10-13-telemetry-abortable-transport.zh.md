# Agent Note: 遥测关闭时销毁被跟踪的 OTLP transport agent

Status: implemented

[English](2026-10-13-telemetry-abortable-transport.md) | 中文

## Problem

`OpenTelemetrySessionBackend.shutdown()` 用 `Promise.race` 给 SDK provider 的 drain 加了 `shutdownTimeoutMillis` 外层截止，但没有任何东西取消底下的 transport。由此产生两处泄漏：

- 挂起的在途导出在截止拒绝后仍持有 socket;provider promise 与 keepAlive agent 继续滞留——deadline 本意要约束的 transport 照样活着。
- SDK 的 HTTP transport `shutdown()` 是空实现，从不销毁它惰性创建的 agent，所以即使正常关闭也会留下占住进程的空闲 keepAlive socket。

上游的等价修复（其 `dsh-otel` reporter 内的 `stopPending`）依附于本树没有的共享 reporter 服务；此后端组合自有管线，取消点只能落在 SDK 暴露的接缝上——agent 工厂。字节有界处理器的 `stopPending` 在同一截止时间丢弃队列；agent 仍覆盖 SDK 无法取消的在途传输。

## Decision

- `trackedAgentFactory` 复刻 SDK 自己的 `agentFactory` 选择——用户给的工厂函数原样使用，options 对象合并到 `keepAlive` 之上，SDK 默认 `{ keepAlive: true }`——并包装代理工厂，使 transport 创建的每个 agent 都进入后端持有的集合。transport 每个协议只调用一次工厂并缓存结果，集合保持有界。
- `shutdown()` 在 `finally` 中销毁每个被跟踪的 agent，无论到期还是正常完成。到期路径下在途请求直接失败而不是遗留在拒绝之后；正常路径下释放 SDK 空实现 transport shutdown 从不关闭的空闲 keepAlive socket。对 SDK 已排空的 agent 调用 `agent.destroy()` 是幂等的。
- 用户自己的 `httpAgentOptions` 继续生效：提供的工厂被包装而非替换，`keepAlive` 与 options 对象按 SDK `convertLegacyHttpOptions` 的合并方式到达生成的 agent。包装函数胜过透传的 `keepAlive` 字段，与用户函数的行为一致。
- `Config.exporter` 与 `Config.processor` 的透传类型同步去掉 `selfObsMeterProvider`——本进程没有归属的 `MeterProvider` 消费 exporter 自观测量，与上游 `b11af342fe4` 一致。

## Alternatives considered

**在自定义 `IExporterTransport` 内中止请求。** `createOtlpHttpExportDelegate` 接受 transport 对象、可携带 `AbortSignal`，但 SDK 的 node HTTP transport 在该面上同样不暴露逐请求取消——`send()` 只把请求和超时交给 `sendWithHttp`——所以同一套 socket 拆除仍要再往下做一层，而 agent 本来就是可取消的对象。

**维持原样：拒绝即忘。** 返回的 promise 确实约束了等待，但把等待所要约束的资源留了下来。收集端挂起时 agent 的 socket 会比拒绝活得久；任何关闭下 keepAlive socket 都会比 provider 活得久。

## Consequences

挂起的收集端不能再比遥测关闭活得更久，健康的遥测会话也不再在插件 disposal 之后泄漏 keepAlive socket。两个透传类型在类型层拒绝 `selfObsMeterProvider`。截止时间契约不变：provider 未在 `shutdownTimeoutMillis` 内结算时 `shutdown()` 依旧拒绝。

## Verification

`packages/session/session-telemetry-otel/tests/otel.spec.ts`——有界关闭用例现在断言 deadline 触发后服务端看到零开放连接，新用例断言干净 `fiber.dispose()` 后 keepAlive socket 被释放；39 个测试通过。

## Related

- [Session 遥测 revival](../feature/2026-07-23-session-telemetry-otel-revival.zh.md)——本修复所环绕的整体透传与不实现 `flush()` 决策。
- [CLI 信号关闭升级](2026-08-03-cli-signal-shutdown-escalation.zh.md)——本次取消补全的外层截止时间。
