# Agent Note: Upstream session lifecycle sync from rc.2..v0.2.2-rc.3

Status: implemented

English | [中文](2026-11-14-upstream-session-lifecycle-sync.zh.md)

## Problem

Upstream `rc.2..v0.2.2-rc.3` reordered session writes under store ownership and fixed released-checkpoint handling; the local session spine needed those fixes, while the batch `append` API and projection-frame refactors were too large to take in the same pass.

## Decision

The store-owned write reorder and the released-checkpoint fix were transplanted; the batch `append` API and projection-frame refactors were deferred to the feature-absorption batch.

- **Session-before-setup publication (`49a7a75d75`)** — `PreparedAgent.publish` became `initializeAndPublish(source, setup?)`: the Session enters and is announced, then setup runs under abort control and commits, then the Agent enters and is announced. Setup can therefore append to a live Session, and a failed or aborted setup disposes the announced Session instead of leaking it. Disposal cancels with `keepInbox: !ready`.
- **Append guards (same batch)** — a Session appends only while its store attachment is live and its announcement is `complete`; detached entries keep an explicit `null` tombstone so stale appends throw `cannot append outside a SessionStore` rather than dereferencing the dead entry.
- **Permission pinning moved to `agent/created`** — `permission-presets` no longer appends inside `session/created` (forbidden by the new guard); it pins initial permission facts on `agent/created` with `prepend: true`, seeds existing agents from `ctx.agents.list()` on remount, and declares `agents` in `inject`.
- **Released projection units stay in checkpoints (`eb1713f856`)** — the last release marks a registration `refs: 0` instead of deleting it. Live drives, restores, `stateOf`, and client snapshots skip released units; `checkpoint()` serves the Session's last cell without materializing a new one, and re-registering the key installs a fresh unit that refolds the log. A writer that checkpoints after a domain plugin unloads therefore keeps the unit's latest state instead of silently dropping the row.
- **`command/done` append containment** — agent disposal now detaches the Session, so a settled command whose `command/done` append can no longer land logs a warning and still returns the settled result instead of throwing the append failure.

## Consequences

- Batch `append` API (`b5969f9e8d`, `748c53b865`, `b3d570cdf8`, `143fabbc34`, `5e77db2d5c`, `7f6b7ba4b6`, `1e7f265cfd`, `e00af4f994`, `e767bef144`, `876c4a4f78`) — multi-event positional tuples, shared live-append validation, and surface-option isolation; feature surface, rides with the tool-executor batch.
- `945006c984` (one projection frame per committed event) and `fcca540841` (unify runtime projection reads) — wire/consumer-facing refactors, deferred to feature evaluation.
- Spec fixtures adopted the upstream pattern (agent-loop testkit harness, `ctx.agents.create`, `vi.waitFor` for async config startup, `agents.register` for fixture agents).

## Alternatives considered

- **Take the batch `append` API here** — rejected: it is a feature surface shared with the tool-executor batch, and bundling it into the lifecycle fix would have hidden the reordering semantics behind an unrelated API expansion.

## Verification

`pnpm exec vitest run` over session, agent, agent-loop, commands, permission-presets, session-projection, session-projection-cache, session-persistence, and session-persistence-jsonl: 105 files, 2544 tests green.
