# Agent Note: Per-node steward projects bound through steward_node_id

Status: implemented

English | [中文](2026-11-07-per-node-steward-projects.zh.md)

## Problem

Resident steward support was designed as one organization-wide steward project (`projects_steward_singleton`) plus a mount per node. That shape cannot host a steward Runtime on more than one node: `instances_organization_project_key` enforces one Runtime instance per project organization-wide, and `resolveTarget` looks the instance up by `(project public_id, assigned_node_id)`. Enabling steward on a second node therefore seeded the mount but the resident Runtime failed with `Runtime assignment is missing`.

A related defect surfaced on the managed Linux node: `prepareStewardWorktree` created the workspace with the Gateway's ownership (root, mode 0755), while the steward Runtime runs as the shared project account (`harness-node-project`), so the Runtime's own workspace rejected its writes.

## Decision

Steward is a per-node project. [projects](../../../../gateway/deploy/postgres/migrations/124_per_node_steward_projects.sql) gains `steward_node_id` (FK to `compute_nodes`, CHECK-bound to `kind='steward'`), `projects_steward_singleton` is replaced by `projects_steward_per_node` (`UNIQUE(organization_id, steward_node_id)`), existing steward projects adopt their assigned Runtime's node plus a `·<node>` name suffix, and stray foreign mounts are deleted. Three backfill edges are hardened: an unclaimed steward (no instance, no active mount) is archived instead of violating the binding CHECK, the rename is skipped under an organization name policy because `require_project_name_claims` would demand claims a migration cannot produce, and the binding CHECK tolerates `status<>'active'` rows.

`ensureSteward` seeds this node's project only: `stewardProject()` filters by `p.steward_node_id`, the insert stamps `steward_node_id` with the local node id, and the display name becomes `<name>·<nodeName>` so the organization-wide name key stays satisfiable. `prepareStewardWorktree` runs `documentRuntimeAccess(runtimeUser, sharedProject=true)` against the workspace so managed Linux nodes get `root:<runtime-gid>` mode `0o2770`; non-managed hosts resolve no adjustment.

Two service-level hardenings accompany the schema: `recoverSteward` answers a `projects_steward_per_node` collision by reviving the bound row (UPSERT on `project_mounts_pkey` restores `status='active'`; the instance row is re-added only when absent) because `insert()` wraps 23505 into a plain `Error` and the constraint identity survives only in the message text; and steward inserts are exempt from the organization name policy — [migration 125](../../../../gateway/deploy/postgres/migrations/125_steward_name_claim_exemption.sql) early-returns `require_project_name_claims` for `kind='steward'` and `insert()` skips the `nameAuthority` requirement for the reserved kind, since each node seeds without a browser actor and no primary-signed proof can exist. `reindexNames` still claims steward rows before `activateProjectNameKey` admits a pending key, so policy coverage is preserved.

## Alternatives considered

**Shared singleton project + one instance per node.** Requires widening `instances_organization_project_key` to include `assigned_node_id`, which opens multi-node Runtimes for every project — a much larger blast radius against single-writer content assumptions and ambiguous-target resolution.

**Center steward + remote execution channel.** Rejected earlier: it rebuilds audited remote shell semantics inside the node channel for a convenience SSH already provides out of band.

## Consequences

Each node's steward qualifies independently: `steward_access_policies` stays node-scoped (written by the local Gateway against its own `nodeId`), the catalog resolves each steward project as a Runtime on its home node, and the Runtime carries only its own node's workspace, deployment tree, and configured read roots — a per-node blast radius with per-node revocation. Administrators see one steward project per node in the project list.

## Verification

- `runtime-management-postgres.spec.ts` seeds two node contexts and asserts distinct bound projects, active mounts, and instance allocations per node, plus idempotent re-seeding and the lost-mount recovery collision path (13/13 with the suite).
- `steward.spec.ts` and `steward-worktree-postgres.spec.ts` still pass (23 + 1 + 11 steward-worktree tests).
- Production: migration applied; `维护中枢·mac-mini` (gen 256), `维护中枢·ubuntu-101-36-115-219` (gen 2), and `维护中枢·windows-vps-47` (gen 6, port 42001) all `ready`; the Ubuntu steward executed real tasks through the public site (`hostname` returned the node's name, workspace writes land as `harness-node-project`, `/var/log` read roots served), and the Windows steward ran `pwsh`-backed `hostname` plus a workspace file write through the same public-session path.
- Windows runs steward under the `local` launcher: the default `harness-project` runtime-user value passes the `HGW_STEWARD=on` startup check and is recorded as launch metadata only, since the local supervisor does not create a sandboxed OS account; `HGW_STEWARD_READ_ROOTS` accepts forward-slash paths (`["C:/releases","C:/harness-gateway"]`).
