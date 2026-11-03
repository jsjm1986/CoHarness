# Agent Note: Authorization attempts retain their service and credential owner

Status: implemented

English | [中文](2026-11-03-authorization-owner-lifetime.zh.md)

## Problem

A retained authorization service can start another credential flow after disposal. A cancelled or completed flow can also retain its Session callbacks and display notices or secret prompts. Looking up credentials again during queued mutation or commit confirmation can substitute a replacement store for the one selected by the original attempt.

## Decision

The [service](../../../../packages/credentials/authorization/src/index.ts) closes admission when its fiber starts stopping, withdraws active attempts and waits for their complete flow and commit tails. Every attempt retains its original credential provider for mutation and confirmation. Disposal preserves [already-admitted writes](2026-10-01-authorization-session-scoped-commit.md); active cancellation cannot transfer a write to a replacement provider.

Retired callbacks publish no notices and reject questions or new commits with `WITHDRAWN`. Questions receive both attempt and question cancellation and refuse a late answer. Synchronous flow failures enter the same settlement handling as rejected flow promises.

Each attempt releases its reserved key exactly once after its owned work. No successor can claim the key earlier. The commit queue absorbs errors while retaining admitted storage failures in its phase; release waits on that queue and the actual flow result.

## Alternatives considered

**Rely on each flow to check cancellation.** A delayed third-party callback can otherwise reopen a question after the caller left.

**Cancel every pending write on unload.** A credential already admitted to storage must complete and report its own outcome.

**Resolve the current credential provider for every step.** The resulting record can belong to a different provider from the attempt's original choice.

## Consequences

Consumers must reacquire a stopped service and finish their own cancelled flow work. Disposal joins uncooperative flow callbacks rather than abandoning them. Credential formats, key reservations and irreversible write admission retain their existing semantics.

## Verification

The real Loader [example](../../../../packages/credentials/authorization/tests/fixtures/owner-lifetime.mjs) checks retained-service refusal, active flow withdrawal, hidden late interaction and committed bytes in the original local credential file. Unit cases exercise provider replacement during an admitted write, prompt cancellation, completed callbacks and concurrent settlement observers.
