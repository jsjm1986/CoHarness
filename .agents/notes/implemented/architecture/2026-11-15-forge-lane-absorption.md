# Agent Note: Forge lane and worktree generation absorption

Status: implemented

English | [中文](2026-11-15-forge-lane-absorption.zh.md)

## Problem

Upstream v0.2.2-rc.3 ships a change-request workflow lane: the `forge` registry, the `forge-github` provider, the `forge-session` projection, the `client-ui-forge` browser face, and a worktree rewrite whose checkouts are recorded per Session, restored after removal, and reclaimed on archive. The fork's worktree package was the earlier generation (create-and-enter only), so every upstream defect fix against checkout lifecycle could not be evaluated, and the reclamation behavior had no local equivalent at all.

## Decision

- Carry `experimental/forge` and `experimental/forge-github` unchanged: the registry core and the GitHub provider land with their own seams, so a local change-request workflow now has a provider-neutral owner.
- Carry `experimental/forge-session` against the local projection registry: `ProjectionHandle` becomes the `sessionProjections.register()` disposer, state reads go through `stateOf(session, 'forgeChangeRequests')`, and the unit is declared in both `SessionProjectionStateMap` and `SessionProjectionMap`.
- Upgrade `experimental/worktree` to the rc.3 generation: the `plugin:worktree/created` fold, generated names, the restore lifecycle, and `WorktreeReclamation` all land; the upstream-only `settings` `configure` presentation call is dropped because no local settings-page generation exists.
- Reclamation state reads thread through `ReclamationHost.projectionState` instead of a handle, and `cachedSnapshot` takes the explicit `inheritedEventCount` the local cache requires — a seeded Session's count is log state the header does not carry, so its identity cannot match a checkpoint and the read falls through to the log.
- Three core surfaces land to support reclamation: the `working-directory/access` waterfall coordinates directory validation with checkout removal, `workspace/session-archived` and `workspace/session-unarchiving` admit and settle archive follow-up work around the durable write, and `SessionQueryEngine.inspectSession` reads domain state off a live or prepared Session without publishing it (`SessionObservationReader.acquire` refactor).
- `client-ui-forge` lands separately under the [panel and remote-access port](../feature/2026-11-15-forge-panel-remote-access-port.md): its React half is a different generation (`*OutlineRegular` icons vs local `*16` names, upstream client-store and session-controller APIs, an upstream-only locales module), so the port rewrites the client against local primitives and carries `dsh-api-remote-access` for the panel's Host face.
- Local directory containment is preserved: `workingDirectory.set` still rejects paths outside the project root, so cross-repository worktree borrowers nest the second repository inside the project.

## Consequences

- Archived Sessions now reclaim their own clean checkouts automatically; forks, directory borrowers, and subagent ancestors hold retention.
- Directory access blocks while a containing checkout drains, so a worktree under removal cannot race a `cd` or `ensure`.
- Cold Sessions answer reclamation from the projection cache when one is mounted and otherwise from an `inspectSession` log read — no Agent is materialized for cleanup.
- `forge-bundle` remains a recorded deferral in the alignment matrix; `client-ui-forge`, `subagent-oar`, and the `sdk-run-commands` pipeline have landed under their own notes.

## Alternatives considered

- Porting `ProjectionHandle` itself was rejected: the local registry already owns generation state through `register`/`stateOf`, so every consumer site adapts to the local idiom instead of growing a second handle model.
- Dropping the `isSeeded`-unknown cache probe was rejected: guessing `inheritedEventCount` for a seeded Session would only ever miss the checkpoint identity, so the explicit unmatchable offset documents the fall-through and keeps semantics honest.
- Relaxing project-root containment to match upstream `set` semantics was rejected: containment is a deliberate fork hardening for logs written without it, and the nested-repository test pattern preserves the coverage without weakening the invariant.

## Verification

- `worktree` suites: 101 tests pass — creation, restore, checkout safety, sandbox confinement, archive reclamation including cold-cache and subagent-ancestor cases.
- `forge` / `forge-github` / `forge-session` suites: 73 + 417 + 135 tests pass unchanged apart from the projection-registry adaptations.
- `session-query`, `working-directory`, and `workspace` suites pass with the new `inspect` / `access` / archive-event surfaces: 1102 tests across all touched packages.
