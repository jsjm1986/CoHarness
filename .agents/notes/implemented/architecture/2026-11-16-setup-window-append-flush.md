# Agent Note: Setup-window append durability

Status: implemented

English | [中文](2026-11-16-setup-window-append-flush.zh.md)

## Problem

rc.3 moved `sessions.announce(session)` ahead of agent `setup` in `setupAndPublish`. Before the change, setup ran while the Session was unpublished, so appends landed in `appendUnstoredSuffix` and reached the durable write handle synchronously; after it, setup appends emit `session/event` into the persistence write-behind queue (`maxDelayMs` batching). The api-proxy's blank-session preset adoption — `agent.session.append('agent-preset/selected', ...)` during `composition.setup` — is the one caller that promises durable-at-return: a reused blank session must carry its adopted preset into any inspection that runs after the operation returns. Under the new ordering the event was live but not yet flushed, so durable inspection raced the write-behind drain and could observe no selection.

## Decision

After the setup-window append, the api-proxy awaits the official durability barrier `ctx.sessions.flush(agent.session)`, restoring the operation's durable-at-return contract without reverting the upstream announce ordering. The append stays an ordinary `session/event`; the flush drains the write-behind queue before `resume`/`reuse` returns.

## Consequences

- Blank-session preset reuse is durable when the call returns; remote/fixture persistence inspection sees `agent-preset/selected` immediately.
- No other setup path appends events, so the flush is scoped to this one adoption point; write-behind batching is unchanged elsewhere.

## Alternatives considered

- Moving the append back before `sessions.announce` — rejected: it would re-split the rc.3 lifecycle the sync deliberately unified, and `appendUnstoredSuffix` is an internal seam callers should not depend on.
- Draining inside `inspect`/`inspectLive` — rejected: read paths must not mutate producer state; the commit-point flush belongs to the writer.

## Verification

- `apps/web/tests/blank-preset-reuse.e2e.ts` — 4/4 on rebuilt `lib/`: durable inspection observes `agent-preset/selected: 'standard'` immediately after reuse, and live+stored compositions agree.
