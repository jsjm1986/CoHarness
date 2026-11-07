# Agent Note: Logout revoke outlasts renewal row locks instead of failing

Status: implemented

English | [中文](2026-11-07-logout-revoke-lock-contention.zh.md)

## Problem

Every browser request renews its session inside `validateSession()`, which takes `FOR UPDATE` on the session row. `revoke()` then updated the same row with no tolerance: when a renewal still held the lock past the pool's `lock_timeout`, PostgreSQL cancelled the update with `55P03` and `/logout` answered 500. Production reproduced it as a full logout failure — the page rendered `internal error` while concurrent fan-out kept renewing the row.

## Decision

[PostgresAuthService.revoke()](../../../../gateway/src/postgres/auth-service.ts) retries only `55P03`, up to four attempts with a 250 ms backoff step, and rethrows anything else. Logout semantics are unchanged: the same single-statement update, the same `revoked_reason='logout'` marker, the same WHERE clause — a lock wait is a timing property, not an authority decision, so waiting out a brief renewal is the correct resolution rather than erroring or weakening the update.

## Alternatives considered

**NOWAIT + client retry.** Surfaces the contention to the browser as an error it cannot meaningfully handle; server-side retry is strictly better because the hold time is bounded by one renewal statement.

**Retry every error.** A revoked, expired, or deleted row deserves its real error; masking non-lock failures would hide genuine bugs behind repeated attempts.

## Consequences

A racing logout now completes once the renewal releases the row, at most ~1.5 s later. Renewals that outlive the four attempts still surface 55P03 — under pathological contention that is the honest answer. The regression spec holds the session row with `FOR UPDATE`, commits mid-retry, and asserts `revoked_reason='logout'` lands (gateway/tests/auth-postgres.spec.ts).
