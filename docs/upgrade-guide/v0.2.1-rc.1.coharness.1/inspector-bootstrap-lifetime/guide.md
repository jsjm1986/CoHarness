---
kind: upgrade-guide
description: "Inspector bootstrap waits survive normal inbound request completion and stop on response disconnect."
---

# Keep Inspector bootstrap waiting until readiness

English | [中文](guide.zh.md)

## Change

The authenticated Inspector bootstrap waits for Worker readiness after its HTTP carrier finishes reading the request body. A live browser receives `200` with bootstrap data or `503` after startup failure. Previously, normal inbound request completion could return `503` before the Worker was ready.

Closing the response connection abandons only that browser's wait, writes no reply after destruction, and leaves shared startup and resource accounting owned by the service. Authentication, URLs and bootstrap fields remain compatible.

## Migration

1. Deploy the complete matching Inspector package and Worker bundle. No configuration or data migration is required.
2. HTTP carriers can drain the request body without ending the pending bootstrap response. Closing the response must propagate client disconnect.
3. Verify a browser opened during queued startup receives bootstrap data after readiness, and leaving that browser does not cancel shared startup. See the [Inspector reference](../../../../packages/experimental/inspector/README.md).
