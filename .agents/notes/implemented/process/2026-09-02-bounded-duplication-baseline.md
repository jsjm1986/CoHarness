# Agent Note: Bound the existing duplication baseline

Status: implemented

English | [中文](2026-09-02-bounded-duplication-baseline.zh.md)

## Problem

The repository duplication gate invoked jscpd with `exitCode: 1` but no threshold. That option made the command fail whenever it found any clone, including the 34 clone groups already present on `origin/master`. The default branch measured 359 duplicated lines out of 313,887 analyzed lines, approximately 0.1144%, so a clean pull request could never satisfy the gate without refactoring unrelated historical code.

## Decision

`.jscpd.json` sets a repository-wide duplicated-line threshold of `0.115` percent and removes the unconditional `exitCode` option. jscpd still exits non-zero when the measured ratio exceeds the threshold. The current baseline remains visible in the console report, while `scripts/duplication-config.spec.ts` pins the narrow ceiling and prevents the unconditional any-clone failure mode from returning.

The threshold is intentionally only slightly above the measured default-branch ratio. It is a regression budget, not a declaration that every current clone is good. Removing clone groups lowers the measured ratio and makes it possible to reduce the ceiling deliberately.

## Alternatives considered

**Keep zero tolerance and refactor all 34 historical groups in this CI repair.** Rejected because it would mix broad product refactors into an infrastructure change and substantially increase review and regression risk.

**Keep `exitCode: 1` alongside the threshold.** Rejected because jscpd treats that option as an unconditional failure whenever any clone exists, so the threshold never becomes a usable baseline boundary.

**Disable duplication failures entirely.** Rejected because future duplication growth would no longer fail the required consumer lane.

## Consequences

Pull requests are judged against a runnable bounded baseline instead of an impossible zero-clone state. A change that pushes duplicated lines above 0.115% fails CI. The console report continues to identify every clone so maintainers can reduce the baseline over time. A change that lowers the measured baseline must lower the threshold in the same pull request.

## Testing

The real jscpd command exits successfully at the current 0.1144% baseline with the configured 0.115% ceiling and exits non-zero at 0.114%. The configuration test verifies the checked-in boundary, and the consumer CI lane executes the complete repository scan.
