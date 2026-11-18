# Agent Note: VNC managed-handshake budget moves to Config so tests can extend it

Status: implemented

English | [中文](2026-11-17-vnc-handshake-timeout-config.zh.md)

## Problem

`managedHandshake` owned a hardcoded `HANDSHAKE_TIMEOUT_MS = 15_000` for the credential-managed RFB negotiation — a deployment-varying budget that violated the no-hardcoded-tunables rule and could not be injected by tests. On the coverage-instrumented self-hosted Windows lane, `splices a credential-managed stream and drops view-level input` timed out twice: the loopback handshake is a handful of in-process socket exchanges, but concurrent forked workers starved the event loop past 15s of wall time, the internal timer fired first, and the test's own 15s ceiling made any accommodation impossible anyway.

## Decision

`Config` gains `handshakeTimeoutMs` (default `15_000`, same schema family as `probeTimeoutMs` and `attachTokenTtlMs`), and `VncRemoteDesktop` threads `this.config.handshakeTimeoutMs` into `managedHandshake`, which accepts it as an optional parameter defaulting to the previous constant. The failing spec now passes `handshakeTimeoutMs: 60_000` and raises its own bound to match, so the lane budget reflects CI load rather than the product's wire-protocol expectation.

## Consequences

- The handshake budget is configurable per deployment like the provider's other timeouts; no consumer changes because the field is optional and the default is unchanged.
- The spec's loopback handshake tolerates a starved CI event loop without weakening the product's real-network failure detection.
- A repeated CI signature becomes a config knob exercised by the same real-composition spec instead of a retried lane.

## Alternatives considered

- Raising the test's vitest timeout only — rejected: the internal `HANDSHAKE_TIMEOUT_MS` fires before the test bound, so a larger test budget changes nothing.
- Raising the module constant — rejected: it doubles real-network failure-detection latency for every deployment to hide a test-environment scheduling artifact.
- Treating the failure as a rerun flake — rejected after the signature recurred on consecutive windows-native runs; the loopback budget should not depend on runner luck.

## Verification

- `packages/remote-desktop/remote-desktop-vnc` suite — 59/59 locally, including the re-budgeted `splices a credential-managed stream` spec.
