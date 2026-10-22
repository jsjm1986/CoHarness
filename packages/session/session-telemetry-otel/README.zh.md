---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

[English](README.md) | 中文

[遥测（telemetry）seam](../session-telemetry/) 的 OpenTelemetry 后端，也是部署方唯一要加载的条目。其 `mode` 决定 seam 是实时跟随会话事件、仅在记录反馈时回放权威日志，还是将遥测留在本地。上传模式组合一个 `LoggerProvider`、本包的字节/条数有界处理器与 OTLP/HTTP 日志导出器，把每条已交接记录映射到 `logger.emit()`，并使用两个插桩作用域（instrumentation scope）：ledger 记录挂在 `@deepseek-ai/dsh-session-sessionTelemetry-otel` 下，运维记录挂在 `@deepseek-ai/dsh-session-sessionTelemetry-otel/ops` 下。资源身份包含 `service.name`/`service.version`（来自 `dsh-llm` 的 `APP_IDENTITY`），以及本包的匿名 `user.id`（`$DSH_HOME/.anonymous-user-id`；首次使用时创建的随机 UUID，删除该文件可重置）；这些身份随每个导出批次携带一次，而非逐条记录携带。

## 概述

`dsh-session-telemetry-otel` 仅在新的显式反馈后通过 OTel JS SDK 导出会话记录，适用于所有用户和提供方，包括 `deepseek-official`。`FEEDBACK_ONLY` 释放截至该反馈的权威日志前缀，包含上下文；后续记录等待下一次显式反馈。`DISABLED` 不构造传输。有界队列可完成已授权的上传，无需另一次用户交互或模型调用。部署方负责脱敏规则。

## 目录

- [配置](#config)
- [哪些数据会离开本机](#what-leaves-the-machine)
- [字段映射](#field-mapping)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="config"></a>
## 配置

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-sessionTelemetry-otel'
  config:
    mode: FULL                # explicit opt-in; default: DISABLED
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    maxRequestBytes: 4000000 # optional; uncompressed request ceiling, never above 4,000,000
    processor: {}            # optional; count/queue/cadence/watchdog knobs of the bounded processor
```

| `mode` | 行为 |
|---|---|
| `FULL` | 每条已投影记录都立即交给 OTel SDK，包括生命周期运维记录。 |
| `FEEDBACK_ONLY` | 每个 `feedback/record` 都会回放权威会话日志中截至该事件的后缀，并进行投影与脱敏。后续记录等待下一个反馈事件；如果没有后续反馈，则留在本地。 |
| `DISABLED` | 默认值。不构造协调器、提供方、处理器或导出器。没有遥测记录会离开进程。`feedback/record` 会记录 `session sessionTelemetry is DISABLED; nothing will be shared and this feedback remains local`；该事件留在本地会话日志中。 |

程序化 TypeScript 配置使用导出的 `SessionTelemetryMode` 枚举（`SessionTelemetryMode.FULL`、`SessionTelemetryMode.FEEDBACK_ONLY` 或 `SessionTelemetryMode.DISABLED`）；原始字符串字面量不可赋值。序列化后的 Cordis 配置继续使用上表所示的字符串值。

上传授权采用显式许可，且为 fail-closed。通过直接构造传入未知模式时，会在读取传输配置前失败。只有 `FULL` 接受对 `ctx.sessionTelemetry.emit()` 的直接调用。`FEEDBACK_ONLY` 向其按需协调器提供私有后端能力，并且仅在 `feedback/record` 对象已经存储于日志且对象身份完全相同（`session.eventAt(event.seq) === event`）时，才将其视为同意；独立发出的总线值会被忽略。即使存在导出器选项，`DISABLED` 也绝不会构造 SDK 流水线。

已挂载的服务通过 seam 的 [`SessionTelemetrySharingStatus`](../session-telemetry/README.zh.md#the-sharing-disclosure) `sharing` 属性披露解析后的模式（`full` / `feedback-only` / `disabled`），因此 `/feedback` 的确认文本可以报告会话是否以及如何被共享。该披露在构造函数中设置，与采集相互独立：即使 `DISABLED` 也会披露 `disabled`。

`exporter.url` 在 `FULL` 与 `FEEDBACK_ONLY` 中必填，无默认值，且必须能解析为 `http(s)`；在 `DISABLED` 中可省略且不使用。在上传模式中，`shutdownTimeoutMillis` 是由 DSH 管理的有限正数外层截止时间，默认值为 3000 ms。`maxRequestBytes` 以未压缩 UTF-8 字节数约束每个 OTLP 请求（含 envelope），只能调低、不得超过采集端上限 4,000,000；`processor` 的每个旋钮（`maxQueueSize`、`maxExportBatchSize`、`scheduledDelayMillis`、`exportTimeoutMillis`）必须是不大于 2,147,483,647 的正整数，且 `maxExportBatchSize` 不得超过 `maxQueueSize`——以上违规均在插件加载时失败。处理器用 SDK 自身的请求序列化器对每条记录只测量一次，并按字节与条数上限贪心打包；单条超限记录经 `ctx.logger.warn` 诊断一次后丢弃（不截断），绝不阻塞后续记录，队列满时同样拒绝新记录。一个 HTTP 请求占有传输槽直至结算：`processor.exportTimeoutMillis` 是看门狗告警而非中止。两个 SDK 配置块整体透传（passthrough），例外是自观测量（`selfObsMeterProvider`，没有归属的 MeterProvider 消费）与 `exporter.httpAgentOptions`（本包对其包装以跟踪每个 transport agent 供关闭时清理）；`OTLPExporterNodeConfigBase` 的其余每个字段（`headers`、`timeoutMillis`、`compression`、`keepAlive` 等）都会到达导出器；持续失败下的传输重试与 socket 行为仍归 SDK 导出器。该后端不实现 `flush()`：常规 flush 由处理器负责。关闭期间，provider 先等待队列排干与 `exporter.forceFlush()`，传输始终拿不到 socket 时该等待可保持未决；若到 `shutdownTimeoutMillis` 仍未结算，排队记录被丢弃，已隔离的关闭失败经协调器记录，应用继续拆卸。无论到期还是正常完成，随后都会销毁每个被跟踪的 transport agent：挂起的在途请求因此失败而不是滞留，SDK 空实现的 transport shutdown 留下的空闲 keepAlive socket 也不会把进程拖住。

<a id="what-leaves-the-machine"></a>
## 哪些数据会离开本机

在上传模式中，记录携带完整的 `event.data`，内容以 seam 的 `sessionTelemetry/record` waterfall（瀑布式事件）返回的结果为准：用户与 assistant 消息内容、工具参数与工具结果（命令输出、文件内容）、完整的系统提示词与工具 schema（`request/header`）、todo 文本、压缩（compaction）摘要、钩子的 `stderrSummary`、反馈文本，以及会话 `cwd`（一个本地路径）。seam 不带任何脱敏规则：未挂载 `sessionTelemetry/record` 监听器时，导出的就是捕获原样的副本，因此向可信边界之外导出的部署方要挂载自己的规则（见 [seam README](../session-telemetry/README.zh.md#the-redact-waterfall)）。`FULL` 在追加时运行脱敏；`FEEDBACK_ONLY` 不保留遥测副本，而是在反馈触发权威日志回放时运行当时挂载的规则。无论如何，提供方凭据都不会出现：适配器的 API key 是构造函数参数而非会话事件，因此它们在结构上就不存在于日志中，也就不存在于遥测中。`DISABLED` 不会构造 SDK 流水线，也不会将任何捕获内容交给后端。

<a id="field-mapping"></a>
## 字段映射

seam 记录 → SDK 日志记录：`time` → `timestamp`/`observedTimestamp`；`severity` → `severityNumber`/`severityText`（INFO 9 / WARN 13 / ERROR 17）；`body` → 结构化日志 body；`attributes` 原样照搬。接收端基于 `(session.id, event.seq)` 去重，并按严重级别告警。在 `FULL` 中，接收端还可通过缺少 `shutdown` 记录检测崩溃：该标记在会话自身 dispose（资源释放）或应用关闭时发出；标记之后出现更多事件，说明遥测发生了重载。在 `FEEDBACK_ONLY` 中，已释放的前缀通常不包含随后的 `shutdown` 标记，因此缺少该标记不是崩溃信号。跨谱系（lineage）的流并不自足：恢复的会话在其自身 id 的流上从上一个进程停止之处继续；fork 出的会话的流从继承边界开始，其前缀位于父会话的流中，由接收端基于 `session.parent_id` + `session.seed_length` 拼接。恢复后的本地日志可能包含从未导出的合成关闭事件；协议流忠实于实际交给 SDK 的记录。

<a id="model-experience"></a>
## 模型体验

无，因为该后端把 seam 记录转发进 OTel SDK 流水线，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **上游实验性源码树**：`@opentelemetry/sdk-logs` 仍从上游实验性（experimental）源码树发布；SDK API 的变动只会落在本包，也仅落在本包；seam 约定不动。
- **真实 collector 行为属于 SDK 导出器**：身份验证、TLS、限流及其他真实 OTLP 部署行为遵循上游 SDK，不由本包自有兼容层处理。
- **反馈时快照**：`FEEDBACK_ONLY` 在反馈前不保留遥测自有副本。记录反馈时，它读取并脱敏当前的权威日志；反馈前发生崩溃时什么都不上传，而反馈前的策略变更会影响该次回放的导出内容。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
