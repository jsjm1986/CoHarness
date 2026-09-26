# Agent Note: Agent-preset picker visibility is a settings field, and the Host resolves one selection policy

Status: implemented

English | [中文](2026-09-25-agent-preset-picker-visibility-policy.zh.md)

## Problem

Upstream alpha.2 lets a deployment hide the Agent-mode picker entirely: the new-session chip disappears and every unnamed session composes from the deployment default while a saved personal default waits out of effect. Porting that to the local project-level settings architecture needed one rule that the Host, the roster, and three client surfaces could all read without trusting a UI to enforce it.

## Decision

**`modeSelectionEnabled` is a second field of the `agent-presets` settings namespace, resolved by the Host on every read.**

- The namespace registers `default` and `modeSelectionEnabled` (schema base `{ default: config.default, modeSelectionEnabled: true }`) with `owner: 'project'`, `projectWrite: 'manager'`, and `projectWritePaths: [['default'], ['modeSelectionEnabled']]` — in a Gateway project scope only a project manager moves either field; in a personal deployment both are ordinary user settings.
- `AgentPresets.selectionPolicy()` is the single read site: `enabled` defaults to `true` when the field is absent, and `defaultId` is the saved `default` only while enabled — `config.default` otherwise. `defaultId` and the remote roster (`remoteExportList`) both read it, so `isDefault` and `modeSelectionEnabled` always come from the same settings snapshot even while the document is hot-reloading.
- The saved `default` is never rewritten by the flag: hiding the picker parks it, and showing the picker makes it effective again. A client with no settings access still gets the answer — the roster reports both the flag and the resolved `isDefault`.
- Enforcement lives in the Host, not in UI omission: `defaultId` (what `mount()` consults for an unnamed session) resolves through the same policy, so a caller that skips every picker still gets the deployment default while selection is off.
- The client honors the same boundary rather than re-deriving it: `AgentPresetSeatController` hides the chip and drops an unconsumed stage when the roster reports `modeSelectionEnabled: false`, guards overlapping roster reads with a generation counter, and only the newest answer may publish. The section controller writes the flag, reloads the roster, and confirms the Host-effective default — on a fresh `agentPresets/list` read, not the published snapshot, which a `settings/document-updated`-triggered read can answer with pre-write state — before optionally syncing the exact blank session captured at write time through the chip's own `agentPresets/select` path — running and historical sessions are never touched.
- The management section keeps selection policy separate from roster work: a hidden picker disables the default pick and the Creator entry (both would claim an effect the Host refuses to apply) while viewing, copying, location, and deletion stay available; the switch is disabled while a write is in flight or the namespace declines this browser's writes (`policyWritable`/`writableReason` from the shared settings describe mirror).

## Alternatives considered

**A roster flag that hides the picker but leaves `defaultId` on the saved default.** Rejected: a saved personal choice would silently compose new sessions on a screen that exposes no choice — the policy would be UI-enforced, and any direct mount caller would bypass it.

**Writing the deployment default into `default` when the picker is hidden.** Rejected: it destroys the saved preference, and re-enabling could never restore it; parking the field keeps the toggle lossless.

**A `hasConversationContent`-style client-side blank check for the sync path.** Already decided against in [the preset remote-boundaries note](../architecture/2026-09-21-preset-remote-contract-boundaries.md); the sync goes through `agentPresets/select`, which owns the turn-boundary blankness rule.

## Consequences

Unnamed-session composition is now a Host-resolved function of two settings fields, and every consumer — chip, General row, section, and any non-loopback client — converges on the roster's answer. A personal-scope deployment gets upstream's behavior verbatim; a project deployment makes picker visibility a manager's policy while ordinary members keep a read-only section with the reason rendered. The [per-preset standing-mounts note](../architecture/2026-08-08-per-preset-standing-mounts.md) owns the composition model the policy selects from.
