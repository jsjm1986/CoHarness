# Agent Note: Spill-local startup cleanup

Status: implemented

English | [中文](2026-09-14-spill-local-startup-cleanup.zh.md)

## Problem

Spilled artifacts persist as files under a private root and are never re-read after their session ends, so a long-lived deployment accumulates orphaned bytes on local disk. Without a sweep, no expiry exists and the prior default roots left behind by earlier processes are never revisited.

## Decision

`spill-local` gains a `cleanupPeriodDays` config field (default 30; `0` disables cleanup). Activation starts a best-effort sweep through a Cordis effect so cleanup never delays service availability, and disposal awaits the same sweep promise so no cleanup I/O outlives fiber teardown. The sweep:

- removes only regular files, inspected via `lstat`, whose `mtime` is strictly older than the cutoff — symlinks, sockets, and directories are never followed or removed;
- prunes a `session-<12 hex>` directory only when it empties, and discovers prior roots matching the `dsh-spill-` prefix plus six alphanumeric characters under the system temp dir, pruning each only when safe and empty;
- deduplicates root aliases by resolved filesystem identity so a configured root and a discovered alias sweep once;
- refuses cleanup across unsafe local-user boundaries on POSIX: directories owned by another user, group- or world-writable ancestors, and any active/configured root are never pruned;
- treats `ENOENT` races with concurrent writers as success and routes every other failure through a warning sink whose own exceptions are contained.

## Alternatives considered

Deleting at read time would leave sessions that never re-open a spill holding files forever, and would couple eviction to the retrieval path. Pruning the active root directory is rejected: the live process writes into it, so the sweep removes only its expired files and emptied session directories, while a discovered prior default root is pruned once it empties.

## Consequences

`saveText` writes stay exclusive (`wx`) and owner-only (`0600`) under the session-hashed directory. Deployments that keep artifacts indefinitely can set `cleanupPeriodDays: 0`; every other deployment bounds spill disk usage to the configured window. `loader-composition.spec.ts` proves the config field reaches the sweep through a real `cordis.yml` Loader run.
