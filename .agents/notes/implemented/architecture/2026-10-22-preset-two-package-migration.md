# Agent Note: preset two-package migration onto the declaration model

Status: implemented

English | [中文](2026-10-22-preset-two-package-migration.zh.md)

## Problem

Upstream rc.2 splits `agent-presets` into `agent-preset` (a declarative plugin that registers a `PresetDefinition`) and `agent-preset-registry` (the roster service backing `ctx.agentPresets.register` with generation lifecycle and `acquireScope`). The fork's `agent-presets` is a richer file-discovery model — roots, trust, authoring/copy/remove, Typert Remote endpoints, inventory, realm-scoped environments, and standing generations keyed to durable selection. How does the fork adopt the upstream declaration seam without dropping the file model every fork surface is built on?

## Decision

Merge, don't replace. The package split is adopted wholesale (rename `agent-presets` → `agent-preset-registry`, add `agent-preset`), while the fork's file-discovery registry remains the semantic core and gains the upstream declaration layer:

- **`AgentPresetRegistry.register(definition)`** validates ids, rejects duplicates, creates a `DeclaredRecord`, and returns an async disposer. Declared generations are realm-keyed scopes retained through `acquireScope` and child-agent joins; unregistration retires them, and `collectDeclared` disposes only when retired and user-free.
- **Dual-source roster** — `list()` emits declared rows first, then file rows under the existing first-root/id shadowing; `resolve` and `resolveMountable` search the combined roster. Declared presets have no `path`: `FileAgentPreset` narrows file-only operations, `read` serializes the stored `PresetDefinition`, and `copy`/`remove`/`openDocument` reject declared presets with `PresetNotWritableError`.
- **`swap`/`recompose`** recognize declared-generation keys alongside file standing keys, preserving the current realm.
- **`compositionInventory`/`inspectCompositions`** report declared definitions through `definitionComposition` and file presets through `fileComposition`, with `modules`/`leakedServices` on the inspection.
- **`agent-preset`** carries the upstream package verbatim-shaped: a `Service` plugin whose `Config` is the `PresetDefinition`, `EntryGroup.key` preserving child expressions until activation, plus creator skills (`agent-experience` joins the repository skill tree through the `.agents/skills` symlink).
- **`skill-filesystem`** canonicalizes loaded skill paths through `realpath`, matching upstream so repository-level skill symlinks resolve to package targets.

The `agent-presets` settings namespace stays unchanged — it is a durable user key, not a package identity.

## Alternatives considered

- **Replace the file model with upstream's declaration-only registry** — rejected: it would delete root discovery, trust governance, user authoring, the Typert Remote surface, inventory, and realm environments, all of which have fork consumers.
- **Carry only `agent-preset` and keep a file-only registry** — rejected: the upstream `ctx.agentPresets.register` seam is the reason the package split exists; without it declared presets have no home and the migration is cosmetic.
- **Rename the settings namespace with the package** — rejected: `agent-presets` is a persisted user-facing key; renaming it orphans stored selections for zero alignment gain.

## Consequences

Consumers compile against the renamed package and `AgentPresetRegistry`; `PresetDefinition` is a public, serializable composition vocabulary. Declared presets participate in inventory and swap but are excluded from filesystem authoring surfaces by construction. `verify-upstream-sovereignty` and the rc.2 alignment matrix record `preset/agent-preset` as `tracked` and `preset/agent-preset-registry` as `adapted`, replacing the deferred-P5 bookkeeping.

## Verification

- `npx vitest run packages/preset/agent-preset-registry` — 181 tests across 11 files pass, including `declared.spec.ts` lifecycle coverage (join, bind, retain, retire, scope release).
- `npx vitest run packages/preset/agent-preset` — upstream skill-loading specs pass against the `realpath`-canonicalized loader.
- `pnpm exec tsc -b packages/host` and the preset package typecheck pass under `exactOptionalPropertyTypes` after the `FileAgentPreset` narrowing.
