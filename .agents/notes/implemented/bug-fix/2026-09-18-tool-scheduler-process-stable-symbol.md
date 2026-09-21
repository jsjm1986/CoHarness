# Agent Note: Process-stable tool scheduler symbol

Status: implemented

English | [中文](2026-09-18-tool-scheduler-process-stable-symbol.zh.md)

## Problem

A source-launch Loader composition loads two copies of `dsh-tools` in one process. The vendored Loader mounts configured entries through Node's internal module loader, which resolves `@deepseek-ai/dsh-tools` to the built `lib` artifact, while the bundled `dsh-agent-loop` artifact resolves its own bare `@deepseek-ai/dsh-tools` import through the tsx `paths` hook to `src`. Each copy declares its own `Symbol('@deepseek-ai/dsh-tools.scheduler')`, so `ctx.tools[TOOL_RUNTIME_SCHEDULER]` evaluated to `undefined` on the `lib` runtime and every tool call ended the turn with `UNKNOWN: Cannot read properties of undefined (reading 'prepare')`.

## Decision

`TOOL_RUNTIME_SCHEDULER` uses `Symbol.for`, the process-global registry that the subagent internal symbols and `TYPERT_OWNED_VALUE` already use for identities that must match across independently bundled copies. The slot is per-`ToolRuntime` instance, so whichever copy answers `ctx.tools`, its own scheduler serves `prepare`/`dispatch`/`finalize`/`finish`.

## Alternatives considered

**Unify Loader resolution onto one plane.** Rejected: making configured entries follow the tsx `paths` hook requires surgery inside the vendored Loader's module loading, upstream mounts entries the same way, and the blast radius exceeds the defect.

**Probe both symbol registries at the consumer.** Rejected: a `ctx.tools` fallback that tries a second key adds a second source of truth for one slot; the global registry exists for exactly this case.

## Consequences

Tool calls succeed under mixed source/artifact compositions, and consistent single-plane runs are unchanged. `Symbol.for` covers this one protocol slot only — `instanceof` checks and private `Symbol()` keys still diverge across module copies, so deeper plane mixing still warrants its own fix. The plane split itself is closed by [ambient source-plane profile resolution](2026-09-21-profile-resolution-ambient-source-plane.md), which keeps source-launch plugin entries and their dependencies on `src`; this symbol stays on the global registry as defense for any residual copy split.

## Testing

The [product headless profile snapshot](../../../../examples/headless-agent/tests/headless.snapshot.ts) drives a tool round trip through the real Loader tree under the source launcher; it failed on the `prepare` lookup before the change and passes after it.
