# Agent Note: 会话遥测 OTLP 请求的字节有界调度

状态：已实现

[English](2026-10-13-telemetry-byte-bounded-requests.md) | 中文

## 问题

`OpenTelemetrySessionBackend` 曾把记录交给 SDK 的 `BatchLogRecordProcessor`，后者只按条数约束队列与批次。一条会话事件的序列化体积只有经过 UTF-8 编码与 JSON 转义后才可知，因此单条超大记录——巨大的工具结果或消息——可能把一个 OTLP 请求推过采集端的 body 上限，让整批在服务端丢失。

## 决策

请求打包归本包：`ByteBoundedLogProcessor`（`src/processor.ts`），即上游 `SessionLogProcessor` 语义在本地管线上的移植（上游 `3dd52bfd9ba`，其载体是 `packages/telemetry/otel`；本树没有共享 otel 服务，因此处理器放在消费它的后端旁边）。

- 每条记录经 `JsonLogsSerializer.serializeRequest` 只测量一次，含其 resource/scope envelope；贪心打包器累加这些已测尺寸，对导出器实际发送的共享 envelope 请求构成保守上界。
- `Config.maxRequestBytes` 只能调低、不得超过采集端上限 4,000,000 未压缩字节；`processor.maxQueueSize`、`maxExportBatchSize`、`scheduledDelayMillis`、`exportTimeoutMillis` 必须是正整数，且批大小不得超过队列——全部在插件加载时校验。
- 单条超限记录经 `ctx.logger.warn` 诊断一次后丢弃而非截断；队列满时同样拒绝后续记录。
- 一个 HTTP 请求占有传输槽直至结算：`exportTimeoutMillis` 是看门狗告警，绝不中止。
- `shutdownTimeoutMillis` 到期时，处理器的 `stopPending` 丢弃队列，tracked-agent 清理让在途传输失败；[abortable transport 笔记](2026-10-13-telemetry-abortable-transport.zh.md)中的两条截止机制在此组合。

## 备选方案

**保留 `BatchLogRecordProcessor` 并在 emit 处限长。** 序列化前限长在两个方向都会猜错：属性、envelope 与 JSON 转义在该时点不可见，截断还会破坏记录的 JSON。

**移植上游共享 `dsh-otel` reporter 服务。** 共享通道服务服务于上游的 product-telemetry 消费方，本树没有；只有一个消费方的服务买到的是间接层而非隔离。

## 影响

每个 OTLP 请求可证明低于配置的字节上限；超限记录被诊断并丢弃，而不再毒化其所在批次。`processor` passthrough 的四个旋钮名称不变，但现在调节的是本包队列——`exportTimeoutMillis` 从 SDK 的到期放弃变为只告警的看门狗，真正的中止仍由 `exporter.timeoutMillis` 与关闭截止时间承担。序列化、持续失败下的重试与 socket 策略仍属 SDK 导出器。

## 验证

`tests/byte-bounded-processor.spec.ts`（25 个测试）：按字节/条数贪心打包且保序、恰达上限放行、单条超限只诊断一次且不阻塞、序列化与传输失败被包容、队列满拒绝、跨批次单一传输槽、看门狗不释放槽位、`stopPending` 丢弃队列、计划延时 flush，以及 `resolveTelemetryLimits` 对每个非法上限的拒绝。`tests/otel.spec.ts` 新增真实管线 wire 用例——`maxRequestBytes: 2048` 下六条小事件送达而超大消息被丢弃并诊断——外加插件加载拒绝用例；全包 71 测通过。

## 相关

- [关闭遥测时销毁受跟踪的 OTLP transport agent](2026-10-13-telemetry-abortable-transport.zh.md)——本队列丢弃与之组合的截止清理。
- [会话遥测复活](../feature/2026-07-23-session-telemetry-otel-revival.zh.md)——本决策收窄的 SDK 立场：为字节界，排队归本包。
