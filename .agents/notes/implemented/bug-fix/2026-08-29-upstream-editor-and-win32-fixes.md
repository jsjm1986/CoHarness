# Agent Note: Preserve UTF-16 paths and tolerate editor placeholders

Status: implemented

English | [中文](2026-08-29-upstream-editor-and-win32-fixes.zh.md)

## Problem

Windows folder-picker paths use UTF-16LE, where a valid BMP code unit can contain a zero low byte. The editor tool also receives JSON placeholders from models that set unused fields to null, while required fields and deletion semantics must remain explicit.

## Decision

The native folder picker scans UTF-16LE code units until both bytes are zero, preserving BMP characters and surrogate pairs. The string-replacement editor accepts null in optional schema fields as an omitted placeholder, normalizes it before command dispatch, and rejects null for `str_replace.new_str` so deletion continues to mean an omitted field. Required command fields still fail when absent, null, or empty where the existing contract requires non-empty text.

## Alternatives considered

**Treat any zero byte as a terminator.** Rejected because U+XX00 characters are valid UTF-16 code units and truncate real paths.

**Interpret null as an empty replacement.** Rejected because model placeholders would silently change file contents; deletion remains the explicit omitted-field operation.

**Make every editor field required.** Rejected because model providers commonly emit a complete argument object with unused fields set to null.

## Consequences

Windows paths containing characters such as 开 remain addressable. Editor schemas describe the provider-compatible null form without weakening command validation, and UI call presentation omits null insertion locations.

## Testing

Native binding tests cover a BMP path with a zero low byte. Editor tests cover schema unions, null placeholders across commands, invalid required nulls, presentation, and unchanged file contents after rejected calls.
