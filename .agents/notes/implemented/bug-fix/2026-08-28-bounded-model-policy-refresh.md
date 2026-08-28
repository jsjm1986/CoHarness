# Agent Note: Bound bulk model-policy refreshes

Status: implemented

English | [中文](2026-08-28-bounded-model-policy-refresh.zh.md)

## Problem

Changing an organization model provider, model, credential, or quota refreshed every user and project policy file serially. Each user refresh also looked the user up again, so a large organization held the administrator request or Gateway startup open for one round trip per subject and could retain a long chain of pending filesystem and credential work.

## Decision

The Gateway enumerates users and projects once, then projects those detached rows with four bounded workers per subject class. The refresh path calls the projection writer directly instead of performing a second `getById` lookup. Startup and retry refreshes use the same bounded pass. A failed pass waits for all workers to settle, reports the first failure, and keeps the existing retry task and lazy durable-revision check responsible for eventual convergence.

## Alternatives considered

**Keep one serial loop.** Rejected because latency grows linearly with every user and project and one slow filesystem operation delays unrelated subjects.

**Use an unbounded `Promise.all`.** Rejected because a large organization would issue one policy, credential, and filesystem operation per subject at once, overwhelming the database pool and host I/O.

**Make every admin mutation wait for a complete background refresh.** Rejected because file projection is an eventually consistent cache; the durable governance revision and runtime lazy check already provide the authoritative recovery path.

## Consequences

Bulk refresh wall time is bounded by four concurrent projection operations per class, while the database and filesystem no longer receive an unbounded burst. A refresh still visits every active subject and can take time proportional to catalog size; transient failures may leave some files at the prior revision until the retry or next runtime use repairs them. Individual user/project mutations retain their direct synchronous projection path.

## Verification

Gateway model-governance integration coverage verifies that a complete refresh uses the enumerated user row without a per-id lookup and writes the expected policy. Gateway typecheck and focused model-governance tests pass.
