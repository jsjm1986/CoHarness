# Agent Note: Resource policy readers retain the current administrator

Status: implemented

English | [中文](2026-11-05-resource-policy-read-authority.zh.md)

## Problem

An authenticated administrator can lose its role, account, membership or organization eligibility while a resource query waits. An HTTP entry check alone lets that accepted request later expose another account's qualification or the steward member directory after withdrawal has committed. Policy reads require the same current administrator identity as policy mutations.

## Decision

[ResourceAccess](../../../../gateway/src/resource-access.ts) retains the active organization, account and administrator membership on the transaction connection that reads the policy. [StewardAccess](../../../../gateway/src/steward-access.ts) uses the same reader for its member directory. The Admin routes pass the authenticated account id to both methods; request fields cannot select it. A withdrawal committed before admission returns403. Once the reader retains qualification, concurrent withdrawal waits for its transaction to finish. The reader uses one pool checkout throughout.

Omitting the service actor selects a trusted internal read. This preserves internal policy inspection without granting an unauthenticated HTTP path. Resource qualification, computer permission and execution admission remain separate decisions. The [steward admission](../feature/2026-10-10-steward-admin-layered-admission.md) and [plugin grant](../feature/2026-10-02-grant-gated-plugin-enablement.md) records retain their distinct execution rules.

## Alternatives considered

**Check the role before issuing an independent policy query.** A queued query can outlive that check and observe data after a committed withdrawal. Retaining database share locks orders the read against qualification changes.

**Retain qualification on one connection and query through the pool.** A pool with one checkout then waits on its own transaction, and separate snapshots complicate authorization. The supplied transaction connection performs every read.

## Consequences

Administrative metadata reads add a short transaction and administrator lookups. An already admitted database reader completes before a waiting withdrawal; subsequent readers are refused. The [JSON publisher](2026-11-05-administrator-read-publication.md) independently rechecks current eligibility before returning that result. Permission rows and revisions are unchanged by the read. Keyless Gateway replay checks all six qualification lanes and the steward directory for role, account, membership and organization withdrawal, plus relation-lock-controlled concurrent demotion. It uses one business connection, actual authentication and PostgreSQL, with no Runtime or model allocation.
