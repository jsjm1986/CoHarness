# Agent Note: Inspector bootstrap waits belong to the response connection

Status: implemented

English | [中文](2026-10-31-inspector-bootstrap-response-lifetime.zh.md)

## Problem

A Node `IncomingMessage` can emit `close` after its request body finishes while the browser still waits for a response. Treating that event as cancellation makes an Inspector bootstrap return `503` before Worker readiness when its HTTP carrier drains the request body. An in-memory adapter that never completes that stream hides the failure.

## Decision

The [bootstrap handler](../../../../packages/experimental/inspector/src/host/plugin.ts) owns its response until startup settles or the response connection closes. Completed request bodies leave the wait active. A closed response abandons only that browser's wait and receives no further writes. Worker startup and its resource permit remain owned by the Inspector service. The streaming prefix dispatcher supplies a parsed matching request URL, so the private handler requires that URL rather than supplying a fallback.

## Alternatives considered

**Cancel on request `close`.** This conflates completed inbound bytes with a closed response connection.

**Cancel shared Worker startup when one browser leaves.** Other browsers and the Host still depend on that service.

**Return `503` after the response is destroyed.** A disconnected browser cannot receive the reply, and writing changes a response the handler no longer owns.

## Consequences

A live browser receives bootstrap data after readiness or `503` after startup failure. Client cancellation ends its network request without changing Host readiness. The test Fetch adapter closes both stream ends on abort and rejects like a browser request. Route authentication and bootstrap fields remain unchanged.

## Verification

Native HTTP tests drain the complete GET body before releasing startup admission. They verify no early headers, a final `200` for a live browser, no writes after disconnect, and continued service-owned startup. The real Loader/Web/Connection [example](../../../../packages/experimental/inspector/tests/fixtures/startup-owner.mjs) records both cases with real Workers; Node 22 and 24 run the same bundled transcript.
