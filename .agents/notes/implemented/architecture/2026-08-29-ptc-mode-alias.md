# Agent Note: Accept PTC as the canonical tool presentation name

Status: implemented

English | [中文](2026-08-29-ptc-mode-alias.zh.md)

## Problem

The upstream vocabulary calls the programmatic tool-calling presentation PTC mode, while existing profiles and session history use Code mode. A hard rename would invalidate deployed patches and replayed configuration.

## Decision

Tool presentation schemas accept `native`, `ptc`, `code`, and `both`. `ptc` is the canonical normalized schema output; `code` remains an accepted input alias. Runtime and scoped presentation normalize both spellings to the existing execution implementation, so direct-call restrictions and SDK behavior remain identical. Historical names remain readable in docs and stored session data.

## Alternatives considered

**Remove `code` immediately.** Rejected because existing profiles, overlays, and clients would fail at load.

**Keep only `code` and rename documentation.** Rejected because new upstream-compatible profiles would be rejected and callers could not use the stable vocabulary.

**Run separate implementations for the two names.** Rejected because two paths could diverge in schema visibility or direct-call enforcement.

## Consequences

New profile output can use `ptc`, while old `code` inputs continue to work. The internal implementation has one mode path, and no Session history rewrite is required.

## Testing

Tool-runtime and scoped presentation tests verify `ptc` schema acceptance, canonical normalization, and the same `run_code`-only wire behavior as the legacy spelling.
