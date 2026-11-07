# Agent Note: Bounded Gateway observation and offline baselines

Status: implemented

English | [中文](2026-10-23-gateway-performance-observation.zh.md)

## Problem

A single Gateway serving many browser connections needs request concurrency, latency, event-loop and memory evidence before node capacity can be calibrated. Retaining every timing sample makes observation itself grow with traffic. Mixing WebSocket lifetimes with ordinary HTTP responses obscures API latency, while measuring only handler settlement excludes streamed response delivery. A benchmark that silently uses synthetic authentication or shares its load generator's CPU cannot establish production PostgreSQL or multiuser capacity.

## Decision

The [process observer](../../../../gateway/src/performance-observer.ts) keeps aggregate counters and exactly three categories: `http`, `internal` and `websocket`. HTTP includes downloads; WebSocket durations measure the complete socket lifetime. `observeResponse()` counts through response `finish` or premature `close`, removes both listeners on settlement and records interruptions separately. `beginRequest()` provides an idempotent completion callback for socket and externally owned lifetimes. Error counts include 5xx responses and interruptions; 4xx responses have a separate count. No route, user, Session or filesystem value becomes a metric label.

Request durations use fifteen fixed upper bounds from 1 ms to 60 seconds plus one overflow bucket. Each cumulative snapshot carries a schema version, a wall-clock start anchored to monotonic elapsed time, category counts, sum, maximum, overflow and non-cumulative bucket counts. `p50Ms`, `p95Ms` and `p99Ms` are bucket-upper-bound estimates; an overflow percentile uses the observed maximum. They are not exact latency samples. Differences between snapshots from the same measurement start produce interval counts, sums and histogram buckets. Cumulative maxima, peaks and percentiles cannot be subtracted to obtain interval values.

Node's native event-loop delay histogram and event-loop utilization cover the observer's lifetime. Process memory is sampled when a snapshot is read. Runtime capacity is supplied by its own service, and database observations remain owned by the Gateway assembly. Disabled observation installs no request listeners or native sampler. Disposal disables the sampler, detaches pending response listeners and freezes request counters, elapsed time and utilization; an unfinished operation remains visible as in-flight at disposal. The observer adds no reporting timer or HTTP route. The [Gateway server](../../../../gateway/src/server.ts) owns the authenticated administrator route and its `no-store` response.

The [counter diagnostic](../../../../gateway/tests/performance-observer.perf.ts) alternates disabled and enabled observation over the same fixed synchronous operations and emits every raw sample as JSON. It measures source execution and excludes HTTP listeners and asynchronous sampler scheduling. The [HTTP diagnostic](../../../../gateway/scripts/performance-baseline.ts) alternates the two modes through the real `createGatewayServer()` entry, consumes every response body, and reports independent client samples together with cumulative snapshots before and after the measured interval. Its private listener binds loopback port zero; temporary files, client keep-alive sockets and server lifetime have awaited cleanup. The CLI accepts no deployment URL.

The HTTP workload contains 50,000 requests at concurrency 20, with a 20,000-request warmup and three samples per mode. Every tenth request reads liveness; others pass fixed authentication, principal and personal-scope routing to a synthetic 4,887-byte runtime response. `source` identifies a source diagnostic. `built` imports the compiled Gateway server and observer without source fallback; the CLI and fixture remain source orchestration. Authentication, stores and runtime output are explicit substitutes. The fixed closed-loop generator shares the process with the server, so neither mode establishes open-loop capacity, 300-user behavior, AI concurrency, PostgreSQL cost, browser interaction, WebSocket fan-out, tunnel overhead or model latency.

The [Session benchmarks](2026-09-04-session-open-performance-gate.md) and [browser budgets](2026-09-06-frontend-performance-budgets.md) retain their independent workload, timing and calibration decisions. This observation mechanism supersedes neither.

## Alternatives considered

**Retain samples or labels per request.** Rejected because memory and cardinality would track traffic or account data. Fixed categories and buckets bound retained timing data independently of completed-request count.

**Time the HTTP handler promise.** Rejected because downloads and proxy streams can outlive the handler. Response completion and socket close measure their actual transport lifetimes.

**Treat the local throughput diagnostic as a capacity gate.** Rejected because fixed external-service substitutes and a colocated closed-loop generator omit the dominant production resource and queueing paths. Capacity acceptance needs a separate load machine, workload mix and deployment path.

## Consequences

The diagnostics distinguish local observation cost from application capacity. The observer's completed-request storage stays fixed; listener retention follows currently observed HTTP responses and is released on completion or disposal. Histograms trade exact percentiles for bounded storage, and their long-running cumulative values require interval differences for recent-traffic analysis. Timing scripts have no pass/fail performance threshold and introduce no capacity claim or CI calibration.

## Verification

Focused observer tests cover simultaneous categories, bucket edges and overflow, duplicate completion, disabled operation, cumulative snapshot independence, response interruption and disposal before late completion. The HTTP fixture verifies identical completed response counts and bytes in both modes, all response bodies consumed, no outstanding measured request after completion, and listener shutdown. Timing measurements remain explicit diagnostics; their raw JSON is required when reporting observation overhead. Functional test timing is not calibration evidence.
