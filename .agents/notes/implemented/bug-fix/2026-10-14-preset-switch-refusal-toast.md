# Agent Note: Announce preset-switch refusals in a banner

Status: implemented

English | [中文](2026-10-14-preset-switch-refusal-toast.zh.md)

## Problem

`AgentPresetSeatState.error` was a bare string, and the chip surfaced it only as the trigger's `title` tooltip. A refused pick — the host answering `agent-preset-locked`, a mount failure with a `reason` detail, or a transport throw — therefore announced nothing: the staged label snapped back to the deployment default with no trace of why. Worse, a refusal can land after the chip hides (a stage applied while *Show coding view* is off still reaches the host), so even the tooltip channel was absent exactly when the failure needed reporting.

## Decision

Selection failures now carry their preset alongside the reason — `error` is `string | { preset: AgentPresetOption; reason: string } | null` — and the chip renders a `Toast` banner (`Could not switch to {name}: {reason}`, 8s hold, anchored to the composer card) whenever an object error is pending. The banner renders even when the chip itself does not, because a refused pick still needs its announcement. `dismissRefusal(refusal)` downgrades the displayed object to its bare reason once the banner finishes, so the trigger keeps the cause as its title without re-announcing; it refuses to downgrade a superseded object, since a newer attempt owns the banner.

- `load()` preserves a pending refusal across roster refreshes — a `list` reply or failure arriving mid-banner no longer clobbers it; string errors still reset on each load.
- The refused `preset` resolves against the roster options, falling back to `{ id, trust: 'system' }` so a pick whose entry left the roster still names itself (`trust: 'system'` resolves built-in localized names and falls through to the id otherwise).
- `syncBlankSession` unwraps the object to its `reason`, keeping the settings section's `Promise<string | undefined>` contract.

## Alternatives considered

**Keep the error a string and render a banner from the string.** The banner copy names the preset — with the staged id already cleared at refusal time, the string alone cannot reconstruct which pick failed.

**Mount the banner outside the chip** (a `shell.overlay` host, as `RowActionToast` does). The chip's own mount is the surface that owns the refusal state, and the chip is registered for the whole conversation scope; an extra overlay entry would own nothing but the same snapshot.

## Consequences

Every refused selection is announced with the preset it named and the host's cause, including refusals that arrive while the picker is hidden. `dismissRefusal` keys dismissal on object identity, so a second refusal of the same preset replays the banner rather than inheriting the first one's silence.

## Verification

`apply.client.spec.ts` — returned and thrown selection failures produce the `{ preset, reason }` object; `dismissRefusal` downgrades to the bare reason, ignores a superseded object, and a roster refresh preserves a pending refusal. `components.client.spec.tsx` — the banner names the preset and reason, renders while the chip is hidden, replays on a second refusal, and routes its finish to `dismissRefusal`. 219 `ui-agent-preset` tests pass.

## Related

- [Per-session agent presets](../architecture/2026-08-03-per-session-agent-presets.md) — the stage/apply contract this announcement rides on.
- [Preset stage outlives the tools toggle](2026-10-14-preset-stage-outlives-tools-toggle.md) — the fix that lets stages land while the picker is hidden, which is how a refusal can arrive with no chip visible.
