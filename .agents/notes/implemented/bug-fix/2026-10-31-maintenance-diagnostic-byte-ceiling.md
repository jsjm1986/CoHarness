# Agent Note: Maintenance diagnostic byte ceiling

Status: implemented

English | [中文](2026-10-31-maintenance-diagnostic-byte-ceiling.zh.md)

## Problem

PostgreSQL maintenance commands can emit large diagnostic chunks and multibyte text. Character counts and unchecked chunk appends exceed a byte ceiling even when the retained string appears short.

## Decision

The command owner retains at most eight KiB of UTF-8 stderr bytes, clipping every arriving chunk before retention. Formatting uses only the complete UTF-8 prefix; a code point cut by the ceiling is omitted. The existing error-line selection and process failure context are preserved. The limit applies to stderr, independently of the command and exit-status context.

## Alternatives considered

**Count characters.** UTF-8 characters have different encoded lengths, so a character ceiling does not bound retained bytes.

**Append the last chunk whole.** A single native read can exceed the remaining budget.

**Decode a clipped buffer with replacement.** A partial final code point would add text the command did not emit. Retaining a tail would also change the established prefix selection.

## Consequences

ASCII and multibyte failure details fit the existing byte ceiling without adding replacement characters at its edge. Exact-limit output remains intact. The runnable command replay checks ASCII, CJK, emoji and an exact-limit control through actual child processes; it does not change the PostgreSQL credential or process-lifetime rules.
