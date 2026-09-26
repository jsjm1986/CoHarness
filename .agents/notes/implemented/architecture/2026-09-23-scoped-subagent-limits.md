# Agent Note: Scoped Subagent settings

Status: implemented

English | [中文](2026-09-23-scoped-subagent-limits.zh.md)

## Problem

The Host exposes delegation limits through settings, but an absent configuration card leaves remote users without those controls. Exposing the entire settings section to project managers would also grant access to deployment-specific continuation budgets.

## Decision

The [Subagent settings card](../../../../packages/client/ui-settings-plugins/src/client/SubagentLimitsCard.tsx) adapts the alpha.2 limit controller and fields to the existing account/project plugin section. Integer validation, independent reset, zero-depth behavior, descendant capacity and expandable help follow upstream. The existing local card owns staged saves and project-owner notices; the local question glyph labels the help action.

The [Host registration](../../../../packages/subagent/subagent/src/index.ts) declares project ownership with manager writes restricted to `maxDepth` and `maxActiveSubagents`. The existing API proxy enforces these paths, refuses other members and rejects wholesale replacement. Deployment-specific continuation budgets are not project-editable. No new settings store or writer is introduced.

## Alternatives considered

**Keep configuration in files only.** This leaves an approved runtime feature inaccessible to remote operators even though a settings service already owns it.

**Make the whole namespace project-writable.** Its local continuation budgets have a different owner; field-level authorization preserves that distinction without duplicating the schema.

## Consequences

Local operators and authorized project managers can configure delegation through the same runtime service. Depth applies to subsequent delegation attempts and does not cancel existing children. Root capacity retains the service's live-count semantics. The separate model-selection namespace uses the upstream route controller and fields within the same local namespace-card system. Its project-manager allowlist covers only `enabled` and `allowedModels`. Host scopes provide an atomic, fixed-revision mutation through the existing queue and describe mirror; account transports retain scalar writes. The switch and exact routes commit together, stale drafts fail, disappeared routes remain removable, and reconnects discard target-specific drafts. Catalog and mutation transport failures preserve retryable user state. These preferences do not replace runtime model governance. Tests cover real Host registration and RPC authorization, browser persistence, field validation and read-only controls.
