# Agent Note: Structured profile boot replaces the patch-stack launcher

Status: implemented

English | [中文](2026-09-18-structured-profile-boot-adoption.zh.md)

> Phase 1B of the dsh-v0.1.6-alpha.2 cumulative upgrade; the [audit ledger](../../../../upgrades/alignment/UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md) records the file-level adoption and deferral list.

## Problem

The launcher composed cordis.yml patches through a local layering stack (`bundlePatches`/`homePatches`/`overlays`) plus `assertEntriesLoaded`/`assertEntriesActivated` text guards, while upstream alpha.2 shipped a structured boot: `ProfileContext` resolution, `readProfilePatches`, `resolutionMode` runtime/link/dual, `StartupError` with structured `inactiveEntries`, and dedicated `dsh-hmr`/`dsh-plugin-manager` packages wired into the base bundle. Keeping the local stack would fork every later upstream profile change.

## Decision

Adopt the upstream boot plane wholesale and replay local product behavior onto its seams:

- `packages/boot/app-boot`, `packages/boot/cmdline`, `packages/host/plugin-inventory`, and `apps/cli` sources align with upstream; `apps/web/tests/scaffold.ts` keeps the local gateway/downlink scaffold with only signature fixes.
- The shipped agent-preset root survives as a derived patch appended after `readProfilePatches`, the same position the telemetry patch occupies; upstream's equivalent `includeShippedRoot` lands with the `agent-presets` migration in 7E and retires the launcher patch then.
- Base and web bundle `cordis.patch.yml` files take the `dsh-hmr` row (`root: []`, `disabled` on missing `profileContext`) and the plugin-manager rows; the old web-side HMR disable is removed because the new package is web-safe.
- New packages `dsh-hmr`, `dsh-plugin-manager`, `dsh-lazy-require`, `dsh-acp-app`, `dsh-sdk-app`, `dsh-sdk-minimal`, and `dsh-mcp-resources` land with local explained-empty invariant companions, matching the standing companion policy rather than upstream's relaxed gate.
- `js-yaml` moves to ^5.2.3 in `apps/cli`, matching the vendored include; `SystemPrompt` config forwarding renames `persona` to `personaPrefix` while `SubagentCapabilities.persona` keeps its separate meaning.

## Alternatives considered

**Merge the layering stack into the new resolver.** Rejected: `readProfilePatches` already owns ordering semantics; a second stack would double every patch-origin diagnostic.

**Drop `SHIPPED_PRESET_ROOT` for upstream's `includeShippedRoot` now.** Rejected: the preset package migration is a 7E surface; the derived patch preserves identical behavior against the current package.

**Adopt the typert protocol migration in the same phase.** Rejected after measurement: `TypertLookupFailure`→`TypertLookupWire`, `codec.schema`→`create`, `$dispatch` removal, and `TypertGatewayAuthorizationRequest` deletion reach api/gateway, apiproxy, remotes, cordis-host-runner, and 15+ client test suites — the gateway plane owns that change, so the four typert packages stay on the local baseline until 7A.

## Consequences

- `pnpm exec tsc -b` is clean; `verify-package-invariants` passes 263 companions; `verify-cordis-config` passes 150 configs; focused suites run 597/601 with the four `plugin-manager/tools.spec.ts` failures legitimately blocked on the 2B/4B sandbox-projection migration.
- Twenty-one e2e files were withdrawn rather than shimmed: they import `dsh-session-snapshot` (3A/2B), `ptc-runtime-node` (4A), `WebBootGraph.batches` (7A), the MCP-2.0 fixture (7B), or `agent-presets.SHIPPED_PRESET_ROOT` (7E), and return when those phases land.
- `resolveShippedPresetPatch`/`composeProfilePatches` are the replay seams to delete when `includeShippedRoot` arrives; `FIRST_PARTY_SECTION_ORDER` consumers now resolve order through `systemPrompt.getSectionOrder`.
