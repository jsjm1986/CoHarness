---
description: "OpenTelemetry backend for the DeepSeek Harness telemetry seam: hands captured session records to the OTel JS SDK's log pipeline"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

English | [中文](README.zh.md)

The OpenTelemetry backend for [the telemetry seam](../session-telemetry/) — the only entry a deployment loads. Its `mode` decides whether the seam follows session events live, replays the canonical log only at recorded feedback, or keeps telemetry local. Uploading modes compose a `LoggerProvider` with the package's byte/count-bounded processor and an OTLP/HTTP log exporter, mapping each handed-over record onto `logger.emit()`, under two instrumentation scopes: ledger records on `@deepseek-ai/dsh-session-sessionTelemetry-otel`, operational records on `@deepseek-ai/dsh-session-sessionTelemetry-otel/ops`. Resource identity contains `service.name`/`service.version` from `dsh-llm`'s `APP_IDENTITY` plus this package's anonymous `user.id` (`$DSH_HOME/.anonymous-user-id`, a random UUID created on first use and reset by deleting the file), carried once per export batch rather than per record.

## Summary

`dsh-session-telemetry-otel` exports session records through the OTel JS SDK only after new explicit feedback, for all users and providers, including `deepseek-official`. `FEEDBACK_ONLY` releases the canonical prefix through that feedback, including context; later records wait for the next explicit feedback. `DISABLED` constructs no transport. The bounded queue can finish an authorized upload without another user interaction or model call. Deployments own their redaction rules.

## Table of Contents

- [Config](#config)
- [What leaves the machine](#what-leaves-the-machine)
- [Field mapping](#field-mapping)
- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

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

| `mode` | Behavior |
|---|---|
| `FULL` | Each projected record, including lifecycle ops records, is handed to the OTel SDK immediately. |
| `FEEDBACK_ONLY` | Each `feedback/record` replays, projects, and redacts the canonical session-log suffix through that event. Later records wait for another feedback event and remain local if none arrives. |
| `DISABLED` | Default. No coordinator, provider, processor, or exporter is constructed. No telemetry record leaves the process. A `feedback/record` logs `session sessionTelemetry is DISABLED; nothing will be shared and this feedback remains local`; the event remains in the local session log. |

Programmatic TypeScript configuration uses the exported `SessionTelemetryMode` enum (`SessionTelemetryMode.FULL`, `SessionTelemetryMode.FEEDBACK_ONLY`, or `SessionTelemetryMode.DISABLED`); raw string literals are not assignable. Serialized Cordis configuration continues to use the string values shown above.

Upload authorization is positive and fail-closed. An unknown direct-construction mode fails before transport configuration is read. Only `FULL` accepts direct `ctx.sessionTelemetry.emit()` calls. `FEEDBACK_ONLY` gives its on-demand coordinator a private backend capability and treats only the exact `feedback/record` object already stored in the log (`session.eventAt(event.seq) === event`) as consent; an independently emitted bus value is ignored. `DISABLED` never constructs the SDK pipeline, even when exporter options are present.

The mounted service discloses the resolved mode through the seam's [`SessionTelemetrySharingStatus`](../session-telemetry/README.md#the-sharing-disclosure) `sharing` property (`full` / `feedback-only` / `disabled`), so the `/feedback` acknowledgement can report whether and how the session is shared. The disclosure is set in the constructor and is independent of capture: even `DISABLED` discloses `disabled`.

`exporter.url` is required in `FULL` and `FEEDBACK_ONLY`, has no default, and must parse as `http(s)`; it is optional and unused in `DISABLED`. In uploading modes, `shutdownTimeoutMillis` is a positive finite DSH-owned outer deadline that defaults to 3000 ms. `maxRequestBytes` bounds each OTLP request in uncompressed UTF-8 bytes, envelope included, and may lower but never exceed the collector ceiling of 4,000,000; every `processor` knob (`maxQueueSize`, `maxExportBatchSize`, `scheduledDelayMillis`, `exportTimeoutMillis`) must be a positive integer no greater than 2,147,483,647, and `maxExportBatchSize` must not exceed `maxQueueSize` — all of these fail at plugin load. The processor measures each record once through the SDK's own request serializer and packs requests greedily under the byte and count limits; a single oversized record is diagnosed once through `ctx.logger.warn` and dropped rather than truncated, never blocking later records, and a full queue rejects new records the same way. One HTTP request owns the transport slot until settlement: `processor.exportTimeoutMillis` is a watchdog warning, not an abort. Both SDK option blocks pass through whole except self-observability metering (`selfObsMeterProvider`, which has no owning MeterProvider) and `exporter.httpAgentOptions`, which this package wraps so every transport agent is tracked for shutdown teardown; every other `OTLPExporterNodeConfigBase` field (`headers`, `timeoutMillis`, `compression`, `keepAlive`, …) reaches the exporter, and transport retry and socket behavior under sustained failure remain the SDK exporter's. The backend implements no `flush()`: the processor owns ordinary flushing. During shutdown the provider awaits the drain plus `exporter.forceFlush()`, which can remain pending when the transport never obtains a socket; if it does not settle by `shutdownTimeoutMillis`, the queued records are dropped, the contained shutdown failure is logged through the coordinator, and application teardown continues. Either way — deadline or clean completion — every tracked transport agent is then destroyed, so a hung in-flight request fails instead of lingering and the idle keepAlive sockets the SDK's no-op transport shutdown leaves behind cannot hold the process open.

<a id="what-leaves-the-machine"></a>
## What leaves the machine

In uploading modes, records carry the complete `event.data` as the seam's `sessionTelemetry/record` waterfall returns it — user and assistant message content, tool arguments and results (command output, file contents), the full system prompt and tool schemas (`request/header`), todo text, compaction summaries, hook `stderrSummary`, feedback text, and the session `cwd` (a local path). The seam ships no redaction rules: with no `sessionTelemetry/record` listener mounted, that is the raw captured copy, so a deployment exporting beyond a trusted boundary mounts its own rules (see [the seam README](../session-telemetry/README.md#the-redact-waterfall)). `FULL` runs redaction at append time; `FEEDBACK_ONLY` retains no telemetry copy and runs the currently mounted rules when feedback triggers canonical-log replay. Provider credentials never appear regardless: adapter API keys are constructor parameters, not session events, so they are structurally absent from the log and therefore from telemetry. `DISABLED` does not construct the SDK pipeline or hand any capture to a backend.

<a id="field-mapping"></a>
## Field mapping

Seam record → SDK log record: `time` → `timestamp`/`observedTimestamp`; `severity` → `severityNumber`/`severityText` (INFO 9 / WARN 13 / ERROR 17); `body` → the structured log body; `attributes` verbatim. Receivers dedupe on `(session.id, event.seq)` and alert on severity. In `FULL`, they may also detect crashes by `shutdown`-record absence: the marker is emitted at the session's own disposal or application teardown, and a marker followed by more events is a telemetry reload. In `FEEDBACK_ONLY`, a released prefix normally has no later `shutdown` marker, so its absence is not a crash signal. Streams are not self-contained across lineage: a resumed session continues its own id's stream from where the previous process left off, and a forked session's stream starts at its inherited boundary — its prefix lives in the parent's stream, stitched via `session.parent_id` + `session.seed_length`. A resumed local log may contain synthetic closers that were never exported; the wire stream stays faithful to records actually handed to the SDK.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The bounded queue holds records exactly as emitted; no second projection exists to compare.

<a id="model-experience"></a>
## Model Experience

None, as the backend forwards seam records into the OTel SDK pipeline and registers nothing model-facing.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Upstream experimental tree** — `@opentelemetry/sdk-logs` is still published from the upstream experimental tree; SDK API churn lands here and only here — the seam contract does not move.
- **Live-collector behavior belongs to the SDK exporter** — authentication, TLS, throttling, and other real OTLP deployment behavior follow the upstream SDK rather than a package-owned compatibility layer.
- **Feedback-time snapshot** — `FEEDBACK_ONLY` retains no telemetry-owned copy before feedback. It reads and redacts the current canonical log when feedback is recorded; a crash before feedback uploads nothing, and policy changes before feedback affect what that replay exports.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
