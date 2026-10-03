# Agent Note: Schedule catalog Session identity and linked-Session reveal

Status: implemented

English | [中文](2026-10-03-schedule-catalog-session-identity.zh.md)

## Problem

Three defects surfaced together in the Web Schedule catalog lane:

1. `schedule/catalog` Host records carry the raw Host `SessionId`, while every browser Session projection — `sessions.ids`, `sessions.byId`, Workspace membership, archive sets — is keyed by the runtime-qualified `ClientSessionKey` (`dsh-session:v1:[runtime,sessionId]`). `sessionLinkState()` compared the raw task `sessionId` against the keyed list, classified a present Session as `unavailable`, and disabled the linked-Session button.
2. `REMOTE_SESSION_POLICIES` declared `['sessionId']` argument paths for the `schedule/*` remotes, but the generated Remote wire form wraps those parameters under `request` (`wire: 'request'`), so `mapRemoteSessionIds()` never rewrote them. A keyed `sessionId` reached the Host unchanged and every keyed read (`history`, `delete`, `update`) failed `schedule_not_found`.
3. `uiWorkspace.openSession` returned the main area to the Conversation only through the layout plugin's current-Session subscription, which early-returns when the selection does not change. Opening the already-selected Session from a main panel (the Automation tasks surface) left that panel active, so the linked Session's Conversation stayed hidden.

## Decision

Normalize at the catalog boundary, not at each comparison. The ui-schedule catalog source maps every `schedule/catalog` entry through `ctx.sessions.keyFor` (falling back to the raw value when the pool does not know it), so the rest of the package — link state, removal, workspace membership — sees the same browser Session identity the Session feed uses. `mapRemoteSessionIds()`'s schedule rows now declare `['request', 'sessionId']`, matching the generated `wire: 'request'` envelope and letting the runtime pool resolve the owning runtime and restore the raw Host id before transmission.

`openSession` reveals unconditionally. Its commit callback calls `ctx.layout.selectPanel(null)` after `ctx.sessions.open(sessionId)`, so reselecting the current Session from a panel surface returns to the Conversation exactly like a fresh selection; the package injects `layout` accordingly. Sidebar reselection keeps the same behavior — an open always shows the Conversation, a plain reselection inside the sidebar still changes nothing else.

## Alternatives considered

**Compare both identity spellings inside `sessionLinkState()`.** Rejected: it spreads raw/key dual handling through every consumer — archive checks, workspace membership, delete paths — while the pool already owns the one sanctioned projection (`keyFor`).

**Reset the panel in the layout subscription for unchanged selections too.** Rejected: `ctx.sessions.list.current` does not change on reselection, so there is no signal to hang the reset on without widening the selection event surface; the reveal belongs to the open operation that requested it.

**Keep `openSession` panel-preserving and have the Schedule link button clear the panel itself.** Rejected: every linked-Session caller (Schedule today, any future panel surface) would reimplement the same two-step, and the upstream contract for open is already "select the Session and show its Conversation as one navigation action".

## Consequences

`schedule/catalog` consumers must treat `sessionId` as already keyed for the browser; code needing the raw Host id goes through `parseClientSessionKey` or the Remote layer's declared mapping. `openSession` callers can no longer open a Session while keeping a main panel up — that is the intended navigation contract; surfaces that want a passive open use `ctx.sessions.open` directly.

## Testing

[schedule-after.e2e.ts](../../../../apps/web/tests/schedule-after.e2e.ts) exercises the full lane: cross-Session catalog reads and Delivery records without activating the linked Session, linked-Session open returning to the Conversation (`2 reminders`/`3 reminders`, Session hierarchy), and catalog deletion of a cold Session. [apply.client.spec.ts](../../../../packages/client/ui-workspace/tests/apply.client.spec.ts) asserts `open` drives `layout.selectPanel(null)`. The scaffold's `extraOverlayPath` accepts a patch list so scenarios can stack the Schedule overlay with the `refreshIntervalMs: 0` time-context fixture ([time-context-every-step.patch.yml](../../../../apps/web/tests/fixtures/time-context-every-step.patch.yml)) that browser-zone assertions need after a non-browser preparation turn.
