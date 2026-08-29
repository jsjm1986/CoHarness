# Agent Note: Derive the shipped preset root for every profile composition

Status: implemented

English | [中文](2026-08-29-derived-shipped-preset-root.zh.md)

## Problem

The CLI owns the installed preset directory, while profile and home patch layers own the agent-presets row. A launcher-time root that replaces user configuration can discard configured roots or become stale after a live patch reload.

## Decision

The launcher composes all bundle, profile, home, and overlay rows, then derives an agent-presets patch that prepends the installed system root to the literal configured roots while retaining every other config field. The same derivation runs for config dumps and every live patch generation. A missing roster row is left untouched; a dynamic config expression or non-array roots value fails loudly because the launcher cannot safely rewrite it.

## Alternatives considered

**Replace the row with only the installed root.** Rejected because deployments may intentionally add trusted organization or user preset roots.

**Bake the installed root into the web bundle patch.** Rejected because the source and built CLI anchors differ and live user-layer edits would not be reflected consistently.

**Derive once at startup.** Rejected because profile and home patch reloads must update the effective roots without retaining a stale composition.

## Consequences

Shipped presets are always available and retain deterministic system precedence, while configured roots and flags remain effective. Config dumps now show the launcher-derived layer, and malformed dynamic roster configuration reports an actionable load error.

## Testing

CLI tests cover prepending and field preservation, absent rows, malformed roots, and composition order; shipped shell and preset composition tests continue to exercise the real bundle layers.
