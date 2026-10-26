# Agent Note: Runtime unary response timing

Status: implemented

English | [中文](2026-10-26-runtime-unary-timing.zh.md)

## Problem

A browser response wait includes Gateway admission, Runtime work and transport. Cumulative process histograms cannot attribute one slow document or history request, and client-side totals cannot distinguish those phases. Request logging would also retain content and identities unrelated to the timing question.

## Decision

[Connection](../../../../packages/client/connection/README.md) exposes an opt-in `serverTiming` setting, disabled by default. ApiProxy fallback POST responses carry two fixed numeric durations: `dsh_conn` covers the accepted Runtime request through its context waterfall and response construction; `dsh_rpc` covers unary payload validation, invocation and JSON construction. Both stop before response-body consumption. Gateway's existing performance setting controls the option in managed profiles.

Clocks are local to each request. They retain no samples, identifiers, paths or contents and introduce no timers or listeners. Registered Remote routes, stream lifetimes, downloads and rejection before the accepted request waterfall keep their existing carriers. Authorization, cancellation, status codes, envelopes and history encoding remain owned by those carriers.

## Alternatives considered

**Use only cumulative latency histograms.** They describe process activity but cannot identify the processing time of one browser request.

**Infer server cost from browser response waiting.** That interval includes network and upstream admission, so it cannot isolate Runtime processing.

**Log every request and payload.** Per-response numeric metrics answer the phase question without retaining sensitive request data or another log lifecycle.

## Consequences

The two durations overlap: subtract them to estimate Runtime work outside unary execution; do not add them. Neither is complete Gateway-to-browser latency. No `dsh_rpc` on a carrier refusal means execution was not measured, rather than zero execution time. Defaults keep standalone profiles unchanged, while deployments can disable managed timings with existing performance observation.

Carrier tests compare bodies and statuses, control the monotonic clock, and overlap requests to pin independent durations. The physical Connection test covers enabled and disabled settings. The runnable Office browser scenario reads both metrics from an actual conversion response while retaining its selectable-content snapshot.
