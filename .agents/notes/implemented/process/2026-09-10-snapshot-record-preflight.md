# Agent Note: Snapshot record preflight

Status: implemented

English | [中文](2026-09-10-snapshot-record-preflight.zh.md)

## Problem

Snapshot replay is intentionally keyless, while recording calls the live model and requires a credential. Without an early check, a recording run can start fixture work and fail later inside a provider, making a missing secret look like a scenario or transport defect.

## Decision

Snapshot record configurations now run a shared `snapshotRecordPreflight()` before Vitest registers scenarios. The preflight optionally loads the repository `.env`, requires a non-empty `DEEPSEEK_API_KEY`, and reports an actionable `snapshot record requires DEEPSEEK_API_KEY` error without printing the credential. The same helper is used by the regular snapshot and web snapshot configs. Replay and refresh do not call the preflight and retain their keyless behavior.

## Alternatives considered

**Let the provider fail when the first scenario calls the model.** Rejected: the delayed error wastes setup time and obscures that the run needs a secret.

**Require the key in every snapshot mode.** Rejected: replay and refresh are designed to be deterministic and keyless.

**Silently skip record scenarios without a key.** Rejected: a skipped record run can look successful while producing no updated evidence.

## Consequences

Record runs fail before scenario execution when the credential is absent or the repository env file cannot be loaded. Keyless replay and refresh remain usable on developer machines and portable CI runners. The preflight is a secret-presence check only; it never logs or validates the credential contents against the provider.

## Tests

`pnpm exec vitest run scripts/snapshot-preflight.spec.ts scripts/ci-workflow.spec.ts scripts/ci-pr-scope.spec.ts` passes. The tests cover present, absent, and empty credentials and preserve the existing workflow contract.
