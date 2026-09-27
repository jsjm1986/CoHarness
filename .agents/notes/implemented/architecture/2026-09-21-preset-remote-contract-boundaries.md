# Agent Note: The preset remote surface keeps typed errors, turn-boundary blankness, and mount wrapping

Status: implemented

English | [中文](2026-09-21-preset-remote-contract-boundaries.zh.md)

## Problem

Upstream's `remote.spec` asserts behavior that the local preset remote deliberately does not have: raw (non-`RemoteError`) rejections pass through to the caller, an empty turn counts a session as started, and mount failures surface as per-row `RemoteError`s. Adapting the ported spec upstream-style would have weakened contracts the cloud host relies on; adapting it locally required the divergences to be stated once, with the locked assertions living in `tests/remote.spec.ts` and `tests/mount.spec.ts`.

## Decision

**Remote failures cross the wire as `RemoteError` only.** `presetRefusal` wraps any throw that is not already a `RemoteError` as `RemoteError('gateway/internal', …)`; unrelated implementation failures never leak their type across the Gateway boundary. The roster and export methods behave the same way — callers pattern-match on `RemoteError.code`, never on `instanceof` of an internal error.

**Blankness is read from the `turnBoundary` projection, not message content.** A session whose only events are command or plugin activity remains switchable; upstream's `hasConversationContent` counts turn starts instead. The local projection is the same source the switch authorizer already consults, so the answer cannot disagree with the rest of the session model.

**A refusal about roots names no preset.** When no writable preset root exists, `PresetNotWritableError` carries an empty preset id — the failure is about the roots a copy could land in, not about the preset being copied.

**Mount failures wrap once, at the mount.** `PresetMountError` is the single error the mount emits; its message carries the flattened row diagnostics (`mountDetail` renders aggregate and cause-wrapped members, indented). Upstream emits one `RemoteError` per row instead; the local wrapper keeps the mount boundary typed while `inactiveRows`/`unresolvableRows` keep the row names readable inside it.

## Alternatives considered

**Pass raw rejections through like upstream.** Rejected: an implementation error's class would cross the Gateway boundary, giving clients a `instanceof` surface that varies with internals. The `gateway/internal` wrap keeps every wire failure inside the declared code space.

**Count a bare turn start as a started conversation.** Rejected: command and plugin activity also opens turns, so a session that never addressed a model would read as mid-conversation and lose switchability it had under the projection contract.

**Let mount failures surface row-by-row like upstream.** Rejected: the caller would need `RemoteError` inspection for a failure that is not remote at all — the mount runs in-process. One typed `PresetMountError` keeps the boundary honest while the flattened diagnostics keep row names.

## Consequences

`tests/remote.spec.ts` asserts `gateway/internal` wrapping for unrelated throws, an empty-id `PresetNotWritableError` on the rootless roster, and switchability of command-only sessions. `tests/mount.spec.ts` asserts `PresetMountError` with flattened member lines for the `nested-broken` group fixture.

The roster API carries no `includeShippedRoot` flag; the shipped root is derived by `profile-boot` patches ([the derived shipped preset root](2026-08-29-derived-shipped-preset-root.md)). The remote roster does report the caller-scoped `authorable` hint and the `modeSelectionEnabled` policy flag — read facts only, with the write living in the `agent-presets` settings namespace ([the picker-visibility policy note](../feature/2026-09-25-agent-preset-picker-visibility-policy.md)).

## Testing

`packages/preset/agent-presets`: `pnpm exec vitest run packages/preset/agent-presets` — 172 tests including the ported `remote.spec` (24) and `mount.spec` (53) assertions written against these contracts.
