# Agent Note: Web browser handoff retains its Node helper

Status: implemented

English | [中文](2026-10-31-web-browser-helper-ownership.zh.md)

## Problem

The Web runtime started a browser-handoff Node helper from an unretained promise. Its injected connection owner could finish disposal while that helper remained alive. A helper error also rejected the operation before native close was observed.

## Decision

The [Web runtime](../../../../packages/bundle/web-app/src/index.ts) retains the handoff promise in its connection-injection context. Disposal cancels the helper and waits for native close. The launcher records its first failure, removes cancellation listeners on close and rejects only after that close. Pre-cancelled work allocates no helper. Expected owner cancellation produces no manual-URL failure warning.

The maintained opener still owns platform handoff semantics. This change owns the short-lived Node helper, not the browser after operating-system handoff. Administrative UI startup is separate from model-request and managed workload admission.

## Alternatives considered

**Discard the handoff promise.** Owner disposal can acknowledge completion with a live child.

**Complete on error or kill request.** Neither event proves native process closure.

## Consequences

Normal startup, credential scrubbing, Windows handoff observation and manual failure fallback remain. The exported native test hook requires its caller's `AbortSignal`. The [ready-page decision](../feature/2026-08-12-open-ready-web-ui.md) remains active; its application readiness and operating-system delegation decisions are independent of helper cleanup.

## Verification

Controlled child tests pause native close during owner disposal, cancellation and error. A shipped `dsh --profile web` scenario replaces only the opener with a private module, starts an actual Node helper and unloads the Web runtime while its HTTP listener remains alive. It observes helper exit before owner acknowledgement without opening a desktop browser or calling a model API.
