---
kind: upgrade-guide
description: "Linux local Runtime allocations retain native subprocess scopes until complete descendant exit."
---

# Upgrade local Runtime descendant ownership

English | [中文](guide.zh.md)

## Change

New Linux local allocations with a working user systemd manager record `nativeRange=linux-slice` in their private owner reservation. The Runtime, probe scopes, pipe and PTY scopes, SDK children and their descendants remain in one nonce-specific slice. Capacity release requires that complete range to be empty. An unavailable user manager retains uncertain occupancy; recovering its availability allows cleanup to continue. The recovery controller can stop the exact slice after supervisor failure without sending signals to numeric PIDs read from disk.

macOS, Linux without a usable user manager and existing process-group allocations keep the documented POSIX process-group guarantee. Native ownership does not add filesystem isolation. Released Session generations and PostgreSQL schemas are unchanged.

Fallback POSIX terminal cleanup refuses partial or unverified process-table observations and retains known descendant identities, even after the root exits. Restore process-table access, then retry cleanup before reclaiming capacity. Custom POSIX inspectors declare `complete: true` only when their table read is complete. Windows uses direct per-identity checks and rejects unreadable identities or failed process enumeration; restore query access and retry cleanup. See the [observation decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-incomplete-process-group-observation.md).

## Migration

1. Upgrade Gateway and managed-computer processes together with the matching local subprocess provider. Preserve their node-local control records and locks. Older control readers reject native owner metadata and cannot recover those allocations.
2. Drain existing local allocations through their original owners. Independently confirm any escaped descendants have stopped before reclaiming uncertain capacity. Start fresh allocations after upgrade; changing a saved record cannot add native containment to a running process.
3. On a Linux host with an available user manager, build the workspace consumers and run `npm run test:built-local-native-supervision` from `gateway/`. The keyless scenario uses the compiled Gateway, real Loader, pipe, PTY and SDK process launcher. Verify Gateway failure recovery, surviving-descendant occupancy, owner failure cleanup and isolation between independent allocations. See the [supervision decision](../../../../.agents/notes/implemented/architecture/2026-10-25-local-runtime-supervisor.md).
