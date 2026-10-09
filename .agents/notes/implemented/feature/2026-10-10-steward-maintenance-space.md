# Agent Note: Steward maintenance space is a reserved project with a resident runtime

Status: implemented

English | [中文](2026-10-10-steward-maintenance-space.zh.md)

## Problem

Maintaining a deployment — inspecting its database, adjusting administrator settings, or preparing code changes — had no in-product channel, and doing it inside an ordinary project runtime couples maintenance to a workspace's own lifecycle: installing a plugin restarts the very runtime performing the work. The request was a conversation-driven maintenance surface that stays up while ordinary runtimes idle, restart, or break.

## Decision

A reserved steward space rides the existing project-space machinery instead of a third runtime target kind. `projects.kind` (`standard`/`steward`, migration 051) marks one reserved project per organization; admission, lifecycle, tooling, and audit are layered on top of it.

- **Qualification is a separate lane.** `steward_access_policies` (user-scoped, enabled flag, revision-fenced admin writes) decides steward admission alone: a qualified active user enters with `rw`, an organization administrator without the row is denied, and member/invitation rows stay empty by contract — project mutations on steward rows are rejected outright. This replaces membership rather than stacking on it, because an empty member table would make the lane unreachable for non-administrators.
- **The runtime is resident and cannot restart itself.** Boot seeds the project and calls `ensureRunning` once; systemd units for steward targets render `Restart=always`, the idle reaper excludes steward projects, and an explicit administrator stop stays stopped until the next boot or explicit start. Plugin-state and plugin-management writes reject steward owners, so the fixed composition (`dsh-steward-tools` via profile patch) can never be changed from inside the space.
- **Identity derives from the database, never the request.** Steward privilege — privileged unit rendering, reaper exemption, query endpoint access — reads `projects.kind` resolved through the instance repository, so a caller-provided flag cannot elevate a standard project.
- **SQL access is an audited channel, not a shell into the database.** `POST /internal/runtime/steward/query` requires the runtime token of a steward-bound generation, reclassifies the statement server-side, enforces statement/row/result/timeout limits, and writes a `steward_query_log` row for every attempt including denials. Keyword classification only selects a lane: read-classified statements run in a `READ ONLY` transaction so `EXPLAIN ANALYZE` and data-modifying CTEs fail closed instead of smuggling writes. Writes additionally require a recent `allowed-once` interaction approval from a still-qualified responder inside a conversation rooted in the same steward project; an advisory lock on the approval id serializes writers so a verdict can green-light exactly one committed write, executed in the transaction that also writes the audit row.

## Alternatives considered

**A `kind='maintenance'` runtime target.** Dropped: it would extend the target discriminated union through instances, plugin state, conversations, audit, proxying, and session-key encoding — a schema and wire expansion to re-derive what project space already provides (isolated cwd, composition, conversations, governance).

**Chat inside `admin-ui`.** Dropped: the admin SPA has no session or streaming stack; the steward space reuses the existing conversation surface at zero client-runtime cost.

**Membership stacked under qualification.** Dropped: steward membership stays empty by design, so `member OR admin` would deny every qualified non-administrator and turn the lane into a dead authorization.

## Consequences

The space cannot operate on itself beyond conversation: composition is locked, worktree changes ship through the ordinary PR and release pipeline, and v1 carries no general runtime-invoke proxy or release-activation automation — both are deliberate deferrals documented in the Gateway README. Residence on the local launcher lasts only for the gateway process's lifetime; only systemd provides restart-under-supervision. PostgreSQL only: the SQLite catalog does not model `kind`, and `HGW_STEWARD=on` is meaningful only where `ensureSteward` is implemented.
