# Agent Note: Byte-bounded OTLP request scheduling for session telemetry

Status: implemented

English | [中文](2026-10-13-telemetry-byte-bounded-requests.zh.md)

## Problem

`OpenTelemetrySessionBackend` handed records to the SDK's `BatchLogRecordProcessor`, which bounds queues and batches by record count only. A Session event's serialized size is known only after UTF-8 encoding and JSON escaping, so one oversized record — a large tool result or message — could push an OTLP request past the collector's body limit and lose the whole batch server-side.

## Decision

The package owns request packing through `ByteBoundedLogProcessor` (`src/processor.ts`), the upstream `SessionLogProcessor` semantics ported onto the local pipeline (upstream `3dd52bfd9ba`, carried by `packages/telemetry/otel` upstream; this tree has no shared otel service, so the processor lives beside the backend that consumes it).

- Each record is measured once through `JsonLogsSerializer.serializeRequest`, including its resource/scope envelope; the greedy packer sums those measured sizes, which conservatively bounds the shared-envelope request the exporter actually sends.
- `Config.maxRequestBytes` may lower the limit but never exceeds the collector ceiling of `4,000,000` uncompressed bytes; `processor.maxQueueSize`, `maxExportBatchSize`, `scheduledDelayMillis`, and `exportTimeoutMillis` must be positive integers, and the batch must not exceed the queue — all validated at plugin load.
- A single oversized record is diagnosed once through `ctx.logger.warn` and dropped rather than truncated; a full queue rejects later records the same way.
- One HTTP request owns the transport slot until settlement: `exportTimeoutMillis` is a watchdog warning, never an abort.
- At `shutdownTimeoutMillis` the processor's `stopPending` drops the queue and the tracked-agent teardown fails the in-flight transport; the two deadline mechanisms from the [abortable transport note](2026-10-13-telemetry-abortable-transport.md) compose.

## Alternatives considered

**Keep `BatchLogRecordProcessor` and cap record size at emit.** A pre-serialization cap guesses wrong in both directions: attributes, envelope, and JSON escaping are invisible at that point, and truncation corrupts the record's JSON.

**Port upstream's shared `dsh-otel` reporter service.** The shared channel service serves upstream's product-telemetry consumers this tree does not carry; a service with one consumer would buy indirection, not isolation.

## Consequences

Every OTLP request is provably under the configured byte ceiling; oversized records are reported and dropped instead of poisoning their batch. The `processor` passthrough's four knobs keep their names but now tune a package-owned queue — `exportTimeoutMillis` changed from the SDK's abandon-at-timeout to a warn-only watchdog, with `exporter.timeoutMillis` and the shutdown deadline remaining the real aborts. Serialization, retry, and socket policy under sustained failure stay with the SDK exporter.

## Verification

`tests/byte-bounded-processor.spec.ts` (25 tests): greedy byte/count packing with order, exact-limit admission, single oversized record diagnosed once and non-blocking, serializer and transport failures contained, queue-full rejection, one transport slot across batches, watchdog without slot release, `stopPending` queue drop, scheduled-delay flush, and `resolveTelemetryLimits` rejection of every invalid limit. `tests/otel.spec.ts` adds a real-pipeline wire case — six small events shipped under `maxRequestBytes: 2048` while an oversized message is dropped and diagnosed — plus plugin-load rejection cases; 71 tests pass across the package.

## Related

- [Destroy tracked OTLP transport agents at telemetry shutdown](2026-10-13-telemetry-abortable-transport.md) — the deadline teardown this queue drop composes with.
- [Session telemetry revival](../feature/2026-07-23-session-telemetry-otel-revival.md) — the SDK stance this narrows: queueing is now package-owned for the byte bound.
