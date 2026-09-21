# @deepseek-ai/dsh-session-projection-cache

English | [中文](README.zh.md)

The persisted projection cache (`ctx.sessionProjectionCache`): durable checkpoints of every projection unit's state, one record per session on the domain data form (`session_projcache` domain — the shipped json backend lands one version-stamped document per session at `<root>/session_projcache/sessions/<id>.json`). Design authority: the [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) (persisted projection cache section).

A stored row `(key → {ver, seq, val})` is a fold shortcut, never an authority: possibly stale (`seq` says exactly how stale) but never wrong. Consequences the implementation commits to:

- **Every background write is fail-soft.** A failed durable write logs a warning and keeps the cache stale; the next write or cold read self-heals. A crash between writes costs a longer tail replay, never a wrong value.
- **A `ver` mismatch against the live unit's `stateVersion` discards, never migrates.** A unit bump invalidates its rows at read time; the key refolds from the log.
- **A row must pass the live unit's `stateSchema`.** A malformed row is omitted from the zero-I/O view and rejected by restore so the cold-read ladder refolds it from the log.
- **Whole-record writes.** Each write replaces the session's full checkpoint (the registry cut is always complete), snapshotted through the lossless-JSON boundary — a unit state violating the plain-JSON contract fails loud.
- **Records are bound to a log lifecycle, not just an id.** Each record stores the complete lifecycle identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`, and the exact `inheritedEventCount`) it was folded from, so a row initialized under another Session format generation or fork cut cannot seed the caller; every read validates it (the live or stored header is the witness) before accepting a row, so a deleted-then-recreated id or a persistence store swapped under a surviving cache discards the unrelated record instead of seeding phantom values.
- **The log leads, the cache follows.** A live checkpoint flushes the session's buffered events durably BEFORE the cache row lands, so a crash can leave the cache behind the log (a longer tail replay) but never ahead of it.

## Summary

This package keeps durable per-session projection checkpoints so history lists, statistics, and goal snapshots can read cached values without loading each session log. Cold projection folds can resume after the checkpointed prefix, reducing restart work. The session log remains authoritative: a crash can leave a checkpoint stale, but never ahead of committed events, and incompatible records are ignored or backed up. Choose it for restarted sessions with frequent projection reads; skip it when projections are live-only or extra storage writes and unbounded checkpoint retention outweigh the saved work.

## Write policy

Three mandatory points, throttled in between:

| Trigger | Nature |
|---|---|
| Session creation | Mandatory — captures seed-derived projection state before the first ordinary event. |
| `turn/end` | Mandatory — the turn-final value is what cold reads want. |
| Session disposal (detach) | Mandatory — the live-to-cold moment; after it the cold ladder serves this session. |
| `writeEveryEvents` committed events | Config throttle (count). |
| `writeIntervalMs` since the first dirty event | Config throttle (interval). |

Both `Config` fields are required (no defaults): flush cadence is a deployment choice with no universally correct value, stated in cordis.yml.

## Listing read (`cachedSnapshot(meta, inheritedEventCount, keys?)`)

The zero-I/O rung: client values viewed straight from the identity-matching stored record (version- and state-schema-matching keys only), returned as a `{asOfSeq, values}` cut. `cachedPredecessorTitle(meta, inheritedEventCount)` is the narrower listing-only exception: a structurally admitted predecessor record whose lifecycle matches may expose only a current-version-compatible `title` row — a possibly stale fact carrying the sentinel `asOfSeq: -1`, never a fold seed. An unseeded listing knows that its cut is zero; a seeded header-only listing does not know the numeric cut and must skip both fast paths until an authoritative body read supplies it. `asOfSeq` is the lowest served-row watermark, so a client seeding its per-session value store under higher-seq-wins can never let a stale list block overwrite a newer push frame. Host-only rows are never returned. `undefined` when no usable client row exists (unknown id, unrelated lifecycle, or no usable rows); the api-proxy list carrier turns that into an absent column.

## Cold read (`coldSnapshot(meta, inheritedEventCount, events)`)

The caller supplies the session's complete ordered log (the session-query observation layer is the shipped producer); the cache seeds each unit from its checkpoint row when usable, folds the supplied events to the cut, and refreshes the record without reading persistence itself. A row seeded from another Session format generation or lifecycle never matches: each record binds the complete identity (`formatVersion`, `createdAt`, `cwd`, `isSeeded`, `inheritedEventCount`). `hydratePrepared(session, events)` is the same seed-then-fold for an already-prepared unpublished Session, writing nothing.

`write(session)` is the synchronous-cut checkpoint all mandatory points use; carriers may call it directly (not fail-soft — the fail-soft wrappers own containment).

## Upgrade compatibility

The domain stores one version-stamped document per session under `<root>/session_projcache/sessions/` (`per-record` layout), so a stale or malformed record discards alone instead of refusing the unit. `compatibleVersions: [3, 4, 5, 6]` keeps structurally valid predecessor documents readable for a current checkpoint rewrite and lets the legacy whole-unit `session_projcache.json` bootstrap once when its stored version is accepted; a record that fails schema validation is moved aside as `<id>.json.bak.<stamp>` under `invalidRecords: 'backup-and-skip'` and rebuilt by the next checkpoint.

## Composition

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

Injects `storageDomain`, `sessionProjections`, `sessions`. Without this row the projection system runs live-only (watermark cache; cold reads fall back to full log folds wherever a carrier implements them).

## Invariants

**Runtime invariant:** No companion is published. Cache records are durable documents written and read through the storage domain; the service projects that same store and keeps no shadow copy.

## Model Experience

None, as the persisted cache accelerates host-side reads of projection state and registers nothing model-facing.

#### KV Cache effect

None; the cache never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **No eviction or retention surface** — records accumulate per session; pruning stored checkpoints is out-of-band maintenance, same stance as session persistence itself.
- **Interval throttle is per-session coarse** — the timer arms at the first dirty event after a clean write; a steady sub-threshold trickle writes once per interval, not a sliding window.
- **`coldSnapshot` folds are not deduplicated** — two concurrent cold folds of one session each seed and fold the supplied log; last write-back wins (rows are equivalent), acceptable for listing-scale call rates.
