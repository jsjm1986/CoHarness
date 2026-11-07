# Agent Note: Session handoff requires completed model extraction

Status: implemented

English | [中文](2026-11-01-session-handoff-completion.zh.md)

## Problem

A provider can emit text before reporting an error, cancellation, output-token exhaustion or tool calls. Session handoff used that partial text as a model capsule. An iterator that ended without any finish was also accepted. The continuation could then receive incomplete state instead of the available local history.

## Decision

Extraction retains the final finish reason and accepts nonempty text only after `stop`. Every other finish or a missing finish returns the authorized local tail. Caller cancellation and the configured handoff deadline still propagate; they do not turn into successful fallback. Cross-session readability still revalidates after extraction before either briefing can be disclosed.

## Alternatives considered

**Accept any nonempty model output.** A partial capsule can omit the state and next step the tool promises to supply.

**Retry extraction automatically.** The tool already has an available local-history fallback; another inference adds cost and delay without establishing that the first output was complete.

## Consequences

The tool schema, routing, permissions, model admission and Session format are unchanged. New failed extractions return a local briefing. Existing logged tool results remain unchanged. The [handoff feature](../feature/2026-10-18-session-handoff-tool.md) continues to define projection and budgets.

## Verification

Package tests reject partial text with every supported non-stop finish and no finish. Actual TypeScript and Python SDK compositions run the real query tool, SQLite history, Agent loop and LlmRuntime for those five interruptions and a normal stop, comparing the returned briefing to the same golden. Private original source and built packages return the partial capsule for the interrupted cases while retaining the normal-stop result.
