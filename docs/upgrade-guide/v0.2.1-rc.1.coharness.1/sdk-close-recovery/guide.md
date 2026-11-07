---
kind: upgrade-guide
description: "SDK clients refuse new work once closing starts and retain failed subprocess cleanup for retry."
---

# Retry failed SDK runtime cleanup

English | [中文](guide.zh.md)

## Change

TypeScript `HarnessClient.close()` and `DeepSeekHarness.close()` can retry failed cleanup of their original subprocess. Pending and successful attempts remain shared. Python serializes close attempts and retains its subprocess when termination or exit confirmation fails. A configured `shutdown_timeout_seconds` also bounds the wait after forced termination.

Both SDKs permanently refuse new work when closing starts. Python rejects new `request()` and `notify()` calls even while shutdown acknowledgement is pending; a failed high-level close also prevents another `start()` or turn. Previously, failed termination could prevent further cleanup, and Python could accept new work during shutdown or wait indefinitely after killing.

Python uses a bounded stdin writer queue, so a runtime that stops reading cannot block request deadlines or process termination. `max_output_bytes` limits queued and active frames together. Invalid request timeouts reject before dispatch. Closing from a notification filter skips joining its own reader thread.

## Migration

1. Await TypeScript `close()` or call Python `close()`. Handle a rejection as incomplete cleanup and retain the same instance. Resolve process-control failures, then retry its `close()`; creating another runtime does not complete the original cleanup.
2. Submit subsequent work through a new instance after the previous runtime exits. Do not reuse an instance whose close has begun.
3. Set positive `shutdownTimeoutMs`, `disposeEofGraceMs` and `disposeGraceMs` in TypeScript, or `shutdown_timeout_seconds` in Python, for the required shutdown windows. Python `None` continues to allow unbounded waits.
4. Confirm the original process has exited before considering its resource occupancy released. No SDK wire messages or stored Session data require migration.
5. Handle Python output-queue admission errors before retrying a message. `notify()` and RPC responses enqueue frames; native write failures reach pending transport consumers. Retain the original client when its writer cannot finish after process exit, and retry `close()` once it can settle. Verify timed-out mutations before retrying them.
