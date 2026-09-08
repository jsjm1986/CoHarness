# Agent Note: Backward scan for final subagent output

Status: implemented

English | [中文](2026-09-08-subagent-output-backward-scan.zh.md)

## Problem

Continuable subagent settlement folded the complete event suffix even when a later non-empty assistant message already determined the final output. Long child histories therefore rebuilt text deltas that could not affect the result.

## Decision

`finalAssistantOutput` scans backward for the last non-empty assistant message and returns it immediately. It retains the existing forward fold only when no non-empty message exists, because streamed text is then the fallback output.

## Alternatives considered

**Always fold the complete suffix.** Rejected because it repeats work for the common settled-message path without changing the result.

## Consequences

Settlement keeps the same output selection and replay behavior while avoiding unnecessary allocations for long continuable histories. The fallback still preserves streamed text ordering when no assistant message was committed.
