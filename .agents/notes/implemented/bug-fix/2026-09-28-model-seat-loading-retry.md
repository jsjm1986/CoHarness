# Agent Note: Model seat auto-retries a failed mount-time load

Status: implemented

English | [中文](2026-09-28-model-seat-loading-retry.zh.md)

## Problem

The composer model seat renders its fallback label (`Select model`) the moment it
mounts, because `current` is `null` until the session's `session.models` RPC
returns. That load is fire-and-forget (errors land on the directory store only),
runs once per mount, and is never retried: a slow request showed a model-less
trigger for seconds to minutes on production, and a failed one left it that way
until the user happened to open the menu or remount the seat. Reproduced on the
production deployment (2026-09-28): after picking a workspace the trigger read
the bare fallback and only self-resolved minutes later.

## Decision

The seat now distinguishes the transient state and recovers on its own:

- While the first load is in flight with no resolved selection, the trigger
  reads `trigger.loading` (`Loading model…`) instead of the bare fallback, so
  "loading" is distinguishable from "broken".
- A failed mount-time load retries with a backoff schedule (1 s / 3 s / 8 s,
  three attempts). The retry is driven by a tick state that re-runs the
  mount-time effect, so it does not depend on consecutive store transitions.
- The attempt counter resets on a `ready` state. Only the load action retries;
  a rejected selection keeps its toast path. Opening the menu still refreshes
  manually, unchanged.

The hero draft (no workspace chosen) still has no model seat at all — no
session means nothing to select a model for — and this note does not change
that.

## Alternatives considered

**Retry inside the injected `load` wrapper.** The wrapper also backs the
menu-open refresh, where a manual retry should stay immediate and single-shot;
buried backoff there would double-fire against the seat's own schedule.

**Surface the error on the trigger.** The menu already owns load errors via its
error strip; duplicating error copy on the collapsed trigger adds noise to the
one control a composer block leaves live.

**Prefetch the catalog at workspace selection.** Shrinks the window but still
leaves failures unrecoverable; kept as a possible follow-up, not a substitute.

## Consequences

The trigger label is reactive to the shared store, so the model name appears
without interaction once a load succeeds. A permanently failing catalog stops
after three retries and keeps the fallback label — no unbounded loop. The
attempt counter lives on the seat instance and resets whenever the directory
reports a ready state, including after a manual menu-open refresh that
succeeds. Section presentations (session settings) never load or retry on mount
and are unaffected.

## Testing

`model-select.client.spec.tsx` covers the loading label, the backoff chain
until a late success resolves the trigger label, and the exhausted schedule
(four calls total, no further growth). Full package suite: 43 passed.
