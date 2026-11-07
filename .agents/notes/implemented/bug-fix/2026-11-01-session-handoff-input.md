# Agent Note: Handoff model input is retained before dispatch

Status: implemented

English | [中文](2026-11-01-session-handoff-input.zh.md)

## Problem

Session handoff sent another Session’s projected conversation to an auxiliary model without recording that input in the calling Session. A returned capsule discards source detail, and the source surface can change. The calling log therefore could not reconstruct the prompt used by the auxiliary request.

Source transcripts can contain dollar sequences. Treating them as replacement instructions changes the text that reaches the model.

## Decision

Each extraction records its source Session, requested route and complete input messages in `session/handoff-llm-request` before entering the existing model stream. Source transcripts, including dollar sequences, enter the prompt literally. The request input is frozen. If logging fails, extraction returns the existing local fallback without dispatching the model. Disabled, oversized and unrouted requests create no input record.

Provider defaults still resolve inside `llm.stream`. Governance therefore retains its execution owner before asynchronous model preparation. The input record preserves the submitted prompt and route; it does not describe a provider-specific HTTP body. Completion, caller cancellation, resource admission and final cross-session readability retain their existing rules.

## Alternatives considered

**Record only the returned capsule or source Session id.** Neither retains the projected source text used by that request.

**Read the source again during reconstruction.** Later projection or access can differ from what was admitted for the original request.

**Move call preparation ahead of the model stream.** Execution-owner capture belongs before asynchronous preparation; logging the existing input does not require moving that work.

## Consequences

The new event is log-only and required on read. An older build that does not recognize it refuses affected logs under the existing event-vocabulary rule. Session header, structural format and tool schemas are unchanged; extraction keeps its existing single model request. Existing committed generations remain unchanged. The [persistence record](../../../../docs/persistence-changes/2026-11-01-session-handoff-input.md) and [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/session-handoff-input/guide.md) define compatibility and deployment.

## Verification

Query-tool and real SQLite tests cover request input, interrupted extraction and logging failure without dispatch. Actual source and built TypeScript SDK and Python SDK compositions verify the record before physical dispatch and read it back through the real persistence provider. Both SDKs compare the same request proof and handoff briefing. A private complete original tool package fails all seven source cases because the record is missing. A separate complete package with recording already present fails the literal-text case in source and built modes.
