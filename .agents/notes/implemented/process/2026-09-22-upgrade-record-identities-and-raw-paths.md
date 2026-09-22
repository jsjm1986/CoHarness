# Agent Note: Unique upgrade decisions and raw upstream path inventories

Status: implemented

English | [中文](2026-09-22-upgrade-record-identities-and-raw-paths.zh.md)

## Problem

Two rows can assign different dispositions to the same upgrade area while both satisfy ordinary field validation. Normalizing an upstream rename into its destination also hides the deleted source path and can introduce a destination that never existed in the compared trees. Row counts and non-empty coverage declarations do not detect either ambiguity.

## Decision

Schema v3 extends the [upgrade-record validation rules](2026-09-13-upgrade-records-gate.md). Matrix `area` values and manifest decision `id` values are explicit, trimmed and unique within their record. The active synchronized tag requires v3 or newer; frozen records from earlier generations retain their original interpretation.

The checker compares `cumulativeFiles` and applicable `incrementFiles` against `git diff --no-renames --name-only -z` between the recorded commits. Each changed path has exactly one row owner. Rename source and destination remain separate raw paths, including their original UTF-8 spelling. Missing, extra or repeated claims fail, as do summary counts that disagree with the computed inventory. `historicalPathAliases` preserves earlier normalized references and their source record without claiming current changes.

The [CI input preparation](../../../../scripts/fetch-upstream-baseline.ts) fetches only missing pinned comparison snapshots from the fixed public upstream repository, using full commit identities and `--depth=1`. The declared target must match the synchronization pin, and an existing mismatched local tag is never replaced. Invalid or unavailable inputs fail before validation can report success; already available snapshots cause no additional fetch.

These checks establish record identity and comparison scope. They do not complete source review, establish equivalent consumer behavior, or transfer an older CI result to a new candidate. The [candidate-bound evidence rules](2026-09-21-candidate-bound-gate-evidence.md) continue to own acceptance.

## Alternatives considered

**Deduplicate the current JSON without an executed check.** This fixes one record while leaving the same conflicting identities and incomplete rename inventories acceptable in the next upgrade.

**Rewrite every historical record under the new schema.** Frozen records describe their own review generation. Upgrading only the current record adds enforcement without changing historical evidence.

**Count normalized paths or fetch the whole upstream history.** Normalized names lose deletion evidence; full history adds transfer cost when comparison needs only the declared trees. Raw paths and shallow snapshots satisfy the current check directly.

## Consequences

An in-progress record can pass structural validation while its pending review states still prevent release. Merging duplicate routing rows preserves all raw path claims and historical provenance without marking either implementation or acceptance complete.

Real CLI tests cover unique and conflicting identities, both sides of a Unicode rename, missing and extra inventories, repeated paths, incorrect counts, active-schema downgrades and frozen-schema compatibility. Separate real Git tests verify missing snapshot acquisition, fixed-URL depth-limited fetches, no refetch, rejected pins and unchanged mismatched tags; the older unrequested ancestor remains absent.
