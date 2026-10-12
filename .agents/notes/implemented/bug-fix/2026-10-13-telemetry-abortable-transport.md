# Agent Note: Destroy tracked OTLP transport agents at telemetry shutdown

Status: implemented

English | [中文](2026-10-13-telemetry-abortable-transport.zh.md)

## Problem

`OpenTelemetrySessionBackend.shutdown()` bounded the SDK provider's drain with `Promise.race` against `shutdownTimeoutMillis`, but nothing cancelled the transport underneath. Two leaks followed:

- A hung in-flight export kept its socket after the deadline rejected; the provider promise and the keepAlive agent lingered, so the transport the deadline was written to bound stayed alive anyway.
- The SDK's HTTP transport `shutdown()` is a no-op and never destroys the agent it creates lazily, so even a clean shutdown left idle keepAlive sockets holding the process open past plugin disposal.

Upstream's equivalent fix (`stopPending` inside its `dsh-otel` reporter) rides the reporter architecture this tree does not carry; this backend composes the raw SDK pipeline, so the abort point has to live at the one seam the SDK exposes — the agent factory.

## Decision

- `trackedAgentFactory` reproduces the SDK's own `agentFactory` selection — a user-supplied function verbatim, an options object merged over `keepAlive`, the SDK default `{ keepAlive: true }` — and wraps the delegate so every agent the transport creates lands in a backend-owned set. The transport calls the factory once per protocol and caches the result, so the set stays bounded.
- `shutdown()` destroys every tracked agent in its `finally`, on either outcome. At the deadline this fails the in-flight request instead of abandoning it behind the rejection; on success it releases the idle keepAlive sockets the SDK's no-op transport shutdown never closes. `agent.destroy()` on an agent the SDK already drained is idempotent.
- The user's own `httpAgentOptions` keep working: a supplied factory is wrapped, not replaced, and `keepAlive` plus options objects reach the produced agent exactly as the SDK's `convertLegacyHttpOptions` would merge them. The wrapping function wins over the passthrough `keepAlive` field the same way a user function does.
- Both `Config.exporter` and `Config.processor` drop `selfObsMeterProvider` from their passthrough types — exporter self-observability metering has no owning `MeterProvider` in this process, matching upstream `b11af342fe4`.

## Alternatives considered

**Abort the request inside a custom `IExporterTransport`.** `createOtlpHttpExportDelegate` accepts a transport object and could carry an `AbortSignal`, but the SDK's node HTTP transport does not expose per-request cancellation through that surface either — `send()` hands the request to `sendWithHttp` with only a timeout — so the same socket teardown would still be required one level lower, where the agent already is the cancellable object.

**Reject and forget, as before.** The returned promise bounded the wait correctly; it just left the resource the wait existed to bound. On a hung collector the agent's socket outlives the rejection, and on any shutdown the keepAlive socket outlives the provider.

## Consequences

A hung collector can no longer outlive telemetry shutdown, and a healthy telemetry session no longer leaks keepAlive sockets past plugin disposal. `selfObsMeterProvider` is rejected at the type level on both passthroughs. The deadline's contract is unchanged: `shutdown()` still rejects at `shutdownTimeoutMillis` when the provider does not settle in time.

## Verification

`packages/session/session-telemetry-otel/tests/otel.spec.ts` — the bounded-shutdown case now asserts the server side sees zero open connections after the deadline fires, and a new case asserts the keepAlive socket is released after a clean `fiber.dispose()`; 39 tests pass.

## Related

- [Session telemetry revival](../feature/2026-07-23-session-telemetry-otel-revival.md) — the verbatim-passthrough and no-`flush()` decisions this wraps around.
- [CLI signal shutdown escalation](2026-08-03-cli-signal-shutdown-escalation.md) — the outer deadline this cancellation completes.
