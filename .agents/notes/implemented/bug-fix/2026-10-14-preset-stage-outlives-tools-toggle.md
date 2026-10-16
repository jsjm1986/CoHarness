# Agent Note: The tools preference clears preset stages on its off transition only

Status: implemented

English | [中文](2026-10-14-preset-stage-outlives-tools-toggle.zh.md)

## Problem

`AgentPresetSeatController` consulted the *Show coding view* preference at compose time: `apply()` and `load()` dropped the staged pick whenever the preference was off. The Creator entries — the settings section's button and the Plugins page add-menu item — are deliberately reachable with the preference off, so with it already off the entry staged `cordis` and started a session — then the chip's mount `load()` (or the session-arriving `apply()`) silently discarded the stage. The new session ran the deployment default instead of Creator mode with no refusal, no error, and no trace. Upstream's contract differs in one detail: the preference clears stages on its off *transition* and never at apply time, so a stage made while it is already off still lands.

## Decision

The seat controller carries no preference: `apply()` composes whatever is staged whenever a blank session is current, and `load()` drops the stage only when the roster reports `modeSelectionEnabled` false — a hidden picker cannot serve a staged pick. `clearStage()` is the public "forget the unapplied choice" operation; the `developerTools.enabled` subscription calls it on every seat when the preference turns off, then `apply()`s so the chip re-derives its reported choice from the current session's composition or the deployment default instead of showing a dead pick.

- A stage made while the preference is already off still lands: `stage()` followed by `apply()` composes the session the flow produces. The Creator entries and the settings-driven blank-session sync stay usable with the preference off.
- A running session's committed preset is untouched in every path: the gate only ever clears the unapplied stage.

## Alternatives considered

**Exempt only `cordis` inside the apply-time gate.** Special-casing one preset id inside the controller hides the real rule — the preference is about *when* a stage was made, not *which* preset it names — and still drops a settings-driven blank-session sync made while the preference is off.

**Keep the apply-time check as a second layer.** A persistent refusal in `apply()` reproduces the silent-discard failure for every stage minted while the preference is off; the off-transition clear already covers the "picked before, preference gone" case the check was written for.

## Consequences

Creator mode started from settings or the Plugins page composes the session it launches whether or not the preference is on, and the header label reports it. Picks staged while the preference is on are still dropped the moment it turns off, and a deployment that hides selection (`modeSelectionEnabled: false`) still drops stages in `load()`. Upstream's per-option `requiresCodingTools` filtering and `reconcileCodingTools` default reset stay unported — they implement the four-surface picker that stays visible and filters PTC/Minimal, while this build keeps the whole chip hidden under the one preference.

## Verification

`ui-agent-preset` specs — a new apply-suite case drives `startCreatorDraft` with the preference off and asserts `select:cordis` lands on the arriving blank session; a second asserts a pick staged while on is dropped on the off transition with the reported choice re-derived to the deployment default. `settings-store` specs replace the apply-time refusal case with an external-clear re-derive case. 212 tests pass.
