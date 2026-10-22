# Agent Note: Managed Runtime process admission

Status: implemented

English | [中文](2026-10-23-gateway-runtime-admission.zh.md)

## Problem

A single Gateway can launch a personal Runtime for every account and a shared Runtime for every project. Per-target lifecycle serialization prevents duplicate processes for one target, but concurrent targets can exhaust a Mac's memory and CPU during startup. Per-instance systemd limits do not provide a shared node budget and do not apply to the macOS local launcher.

## Decision

The [InstanceManager](../../../../gateway/src/instances.ts) acquires one resident reservation and one cold-start slot before policy materialization, maintenance admission, or process launch. Readiness releases only the cold-start slot. Confirmed process-tree termination releases the resident reservation; a failed termination retains its handle and reservation. Local child exit notifications trigger serialized cleanup, while startup failure and explicit stop use the same termination rule. Shutdown closes queue admission, cancels pending starts, and awaits their settlement before draining local processes. These rules complement the [Gateway startup ownership](../bug-fix/2026-08-18-gateway-startup-resilience.md) and [maintenance](2026-09-25-gateway-deployment-maintenance.md) decisions.

The [capacity controller](../../../../gateway/src/runtime-capacity.ts) admits distinct Runtime targets in FIFO order. A full resident budget waits for an existing process to stop or become eligible for idle reaping; it does not evict busy processes. Queue size and wait time are bounded, retries for the same target and start intent share their pending operation, and stop cancels that target's queued start. Warm Runtime calls do not acquire a cold-start slot. PostgreSQL and SQLite repositories enumerate active assignments before admission; supervisor survivors, including incomplete starts and stops, count even when they exceed a reduced limit. Uncertain survivor state is retained until termination is confirmed. Incomplete starts or stops refuse replacement immediately; recovery requires a successful administrator stop followed by an explicit start. Launcher rejection confirms that no process remains or returns a `RuntimeLaunchCleanupError` carrying the process handle for cleanup.

`startRequest.admission` resolves after bounded-queue acceptance, immediate slot reservation or warm reuse; `startRequest.completion` resolves only after authenticated readiness. The ordinary HTTP proxy awaits admission before returning its waiting response, so an already-full queue returns HTTP 503 `INSTANCE_CAPACITY` with `Retry-After`. After acceptance, HTML requests receive the existing 200 waiting page and API requests receive 503 `INSTANCE_STARTING` while startup continues. A later queue timeout or cancellation rejects completion and remains visible in admission counters, but cannot replace an HTTP response already returned.

Validated node settings expose `HGW_RUNTIME_MAX_STARTING`, `HGW_RUNTIME_MAX_RESIDENT`, `HGW_RUNTIME_MAX_QUEUED`, and `HGW_RUNTIME_QUEUE_WAIT_MS`. Defaults are 2 cold starts, 8 resident reservations, 32 queued targets, and a 30-second queue deadline. They are configurable protection starting points for the current Mac deployment, without a calibrated memory-per-Runtime result. They do not establish that a 16 GiB Mac supports 300 personal Runtimes or 100 mixed AI tasks. Existing node-configuration records lacking additive settings read bootstrap values or the declared defaults; explicit malformed values still fail validation.

The public snapshot reports current and peak process/queue counts, rejections, queue cancellations and timeouts, target-identifier bytes, and fixed cumulative wait buckets. Identifier bytes exclude caller-owned request data and are not a measurement of total queue memory. One Gateway owner accounts for its managed processes on one node; independent Gateways sharing a host and unmanaged processes do not share this in-memory budget.

## Alternatives considered

**Use per-Runtime CPU and memory limits as the node budget.** These limits are platform-specific and their aggregate can exceed host capacity. Runtime process admission applies to both launchers; it does not claim to bound the CPU or memory used inside an admitted Runtime.

**Evict a resident Runtime immediately when another target waits.** Existing leases and task lifecycle rules own safe idle release. FIFO waiting with a deadline preserves those owners instead of terminating active work for capacity.

**Release after requesting termination or after a child root exits.** Descendants can retain resources and ports. Capacity is reusable only after the launcher's awaited termination completes; unknown termination keeps the reservation.

## Consequences

Cold bursts have bounded process starts and queue length, and retries cannot bypass the resident budget. Capacity exhaustion can delay or refuse a previously stopped space; lowering the limit does not terminate existing spaces. Runtime admission does not schedule Agent turns, LLM requests, tools, terminals, or their descendants within a resident Runtime. Those operations require their own cross-process resource ownership and admission; process-count limits alone do not protect the whole machine from mixed workloads.

Deterministic controller tests cover a 100-target burst, FIFO, both limits, cancellation, timeout, survivor accounting and idempotent release. InstanceManager tests exercise real local child startup, hot calls while another target waits, duplicate retries, queued stop cancellation, crash cleanup, retained reservations after failed termination and shutdown quiescence. [Real HTTP proxy tests](../../../../gateway/tests/proxy.spec.ts) combine the actual manager with a controlled launcher to verify queue-full refusal before readiness, accepted waiting responses and recovery after capacity release. Configuration tests reject invalid values and node-configuration tests cover persistence and additive-field reads. Timing and resident-memory calibration, a mixed-workload benchmark, and an assembled capacity-failure transcript remain separate evidence.
