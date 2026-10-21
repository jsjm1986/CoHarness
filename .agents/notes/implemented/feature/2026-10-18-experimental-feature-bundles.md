# Agent Note: Experimental feature bundles for upstream showcase rows

Status: implemented

English | [中文](2026-10-18-experimental-feature-bundles.zh.md)

## Problem

Upstream rc.2 ships five thin opt-in bundle packages that give its plugin-manager showcase one toggleable row per capability: persistent terminals, conversation-following session titles, the DSH badge skill, Ralph loops, and session search. The fork composes the same capabilities differently — several are already parked disabled in `dsh-base` — so the showcase had no row to toggle and copying the upstream patch verbatim would insert duplicate row ids.

## Decision

Each upstream bundle maps to a fork package under `packages/experimental/` that keeps the fork's management model: a `cordis.patch.yml`, bilingual locale metadata, the upstream `icon.svg`, an empty `src/index.ts`, a patch spec, and bilingual READMEs. All five are registered in `OPTIONAL_BUNDLES` in [`packages/boot/app-boot/src/profile.ts`](../../../../packages/boot/app-boot/src/profile.ts), so the plugin-manager showcase lists them and enabling one applies its patch over the shipped profile; none enters a shipped default composition.

Patch contents follow upstream with fork-specific targeting where the rows already exist:

- `terminal-bundle` copies upstream's isolated `optional-persistent-terminals` group (`terminals: true`) with the terminal registry, bash/pwsh backends, and `tool-terminal`.
- `session-titles-bundle` disables the shipped `session-title-llm` row and inserts `dsh-session-title-all-prompts-llm` with upstream's tuned config (targetWords 5, targetCjkCharacters 10, maxInputBytes 4096, maxOutputTokens 64, timeoutMs 60000).
- `badge-skill-bundle` enables the existing `skill-badge` row instead of inserting a duplicate.
- `ralph-bundle` inserts upstream's isolated `optional-ralph` group (`workflowEngine: true`) holding `workflow-ptc` (provider `spawn`) and `tool-ralph` (subagentProvider `spawn`, maxRounds 64).
- `session-search` inserts an isolated `optional-session-search` group (`sessionQuery: true`) with an in-memory SQLite search index opening on first search plus `tool-session-query`; the shipped `session-query-sqlite` row stays `openAt: never`.

Each bundle's `package.json` declares the row plugins it composes as dependencies, exports `cordis.patch.yml` and `locale/*.json`, carries `dsh.bundle.patch`, and is a runtime dependency of `apps/cli`. The upstream-sync manifest classifies all five `adapted`, with this note as evidence.

## Alternatives considered

- **Verbatim upstream patches** were rejected where the fork already composes the row: `applyEntryPatches` would either collide on duplicate ids or leave two providers active; id-targeted overrides express the same intent over the fork's parked rows.
- **Editing shipped compositions** was rejected: the opt-in bundle model keeps default profiles byte-identical while still giving the showcase a toggle.

## Testing

Each package's `tests/patch.spec.ts` parses its `cordis.patch.yml` and asserts the row structure. `scripts/optional-bundles.spec.ts` applies every registered optional bundle over the shipped Web layers and rejects skipped patches, duplicate top-level ids, and invalid id-targeted overrides — it covers all five bundles. `verify-default-product-isolation` confirms no experimental package entered default runtime dependencies or shipped compositions; `verify-upstream-sovereignty` validates the manifest entries.

## Consequences

- Enabling a bundle is per-profile and reversible; shipped defaults are unchanged.
- `docs/config-catalog.md` lists the bundles in the library section (empty `src/index.ts`, no plugin export), consistent with the existing `schedule-bundle`/`plugin-market-bundle`/`agent-team-profile`/`voice-input-bundle` entries.
- `ralph-bundle` and `badge-skill-bundle` toggle rows that shipped compositions also park; the isolated group in `ralph-bundle` keeps `workflowEngine`/`terminals`/`sessionQuery` service scoping identical to upstream.
