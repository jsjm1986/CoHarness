# Agent Note: Preparation-pool publish veto fired on cached cold reads

Status: implemented

English | [中文](2026-10-10-preparation-pool-publish-veto.zh.md)

## Problem

`SessionPreparations.reservationFor` rejected every same-id `Session` publication whenever the pool held any entry for that id — throwing `cannot publish session: persisted state already owns this identity` unless the published object was the exact reserved `Session`. `inspect()`, `open()` through `inspectStored`, and every read path on coordinator backends (SQLite, gateway) leave a `ready` entry in the pool's LRU, so a plain read permanently poisoned later `sessions.create()` and resume publishes for that id; the only escapes were an `appendCore`-driven `invalidate`, LRU eviction, or process restart. Agent resume through `persistence.open(id, 'write')` + `sessions.prepare` publishes a different object than any pooled one, so the veto fired on a legitimate flow whenever a concurrent `inspect`/`load`/`prepare` re-seeded an entry between the resume's invalidating append and its publish — and a rejected publish left the entry in place, so retries kept failing. The resume path had no integration coverage because every agent-loop resume spec runs the JSONL backend, which never touches `PersistenceCoordinator`.

## Decision

Only a held `reserved` entry owns an unpublished identity. `reservationFor` now drops `loading`, `ready`, and `committing` entries and returns `undefined`, letting the publish proceed through `onCreated`/`adoptLivePrefix`, where `seedCoversPrefix`, `cwd`, and `inheritedEventCount` checks remain the authoritative collision arbitration. `reserved` with a different Session object still throws — a preparation holder's exact-object publish is the one true alias conflict. Every displaced waiter converges through machinery the pool already had: `reserve()` returns `undefined` on a removed entry so `prepare()` retries into its `while it is live` refusal, `inspect()` re-checks the store and returns `inspectLive`, and the shared `entry.result` deferred still resolves or rejects for queued observers.

`prepareCore` refuses at its detached-`Session` minting boundary with `SessionAlreadyExistsError` when the id went live during the storage reads; the error passes the corruption wrap unwrapped because a live-identity conflict is not damage. `load()`, `prepare()`, and `inspect()` convert that refusal: `load()` returns `loadLiveSnapshot` (or retries when the id has since left), `prepare()` rethrows the deterministic `while it is live` conflict, and `inspect()` retries or returns `inspectLive`. An abort still wins over the conversion.

## Alternatives considered

**Keep the veto for `loading`/`committing` and yield only on `ready`.** Rejected: it shrinks but keeps the crash window for a legitimately publishing write-handle holder racing a cold read, and a rejected publish still leaves the entry to fail later publishes — the metastasizing half of the bug.

**Make agent-loop resume publish the exact pooled object via `persistence.prepare()`.** Rejected: the open-handle resume flow is a valid alternate path whose publish is already self-verifying through `adoptLivePrefix`; the pool gate, not the publisher, was over-broad. Both publication forms stay supported.

## Consequences

Publishing a `Session` over an id whose cold read is in flight or cached now wins instead of crashing; the cold work converges on the live session. In-flight `commitPrepared` work still lands before the publisher's serialized adoption, and a live session claiming a repaired log must still cover it via `seedCoversPrefix` — genuine id collisions keep failing with `id collision`. `load()` on a live session with an open turn still rejects with the designed live-turn refusal. `assertWritable` still blocks cold appends during `committing`/`reserved`, so durable repairs never interleave with writes.

## Verification

`preparations.spec` covers yield-on-`ready` (returns `undefined`, entry dropped, later `reserve` succeeds), yield-on-`loading` and yield-on-`committing` (waiter resolves `undefined`), and the kept `reserved`-with-foreign-object rejection. `persistence.spec` covers a publish over an inspection-cached entry end-to-end, a live publish winning over a gated in-flight cold `load` (the load converges to the live-turn refusal), and a retirement-racing publish whose empty seed still fails adoption with `id collision` while the store stays untouched. The `became-live` mock suite pins `prepare`/`load`/`inspect` conversion to the live view or conflict.
