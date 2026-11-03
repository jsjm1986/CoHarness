# Agent Note: Browser authority after authentication lock waits

Status: implemented

English | [中文](2026-10-24-browser-authentication-lock-waits.zh.md)

## Problem

PostgreSQL browser validation joined account and membership facts before locking the login-session row. A request waiting for that lock could retain an administrator role after a concurrent demotion committed. Its expiry predicates used transaction-start `now()`, so the same wait could also authorize a session whose idle or absolute deadline had passed. SQLite accepted equality at either deadline and could renew an exactly idle-expired token.

Login captured its timestamp before password verification and distributed admission. Time waiting for those operations shortened the issued session's usable lifetime; failure recording and lockout-window checks also used the earlier arrival time.

## Decision

Validation conditionally renews the matching live session in one autocommit statement. A materialized locking query supplies the session’s deadlines only after acquiring its row lock; renewal checks those deadlines against the current clock before changing timestamps. Its row lock is released before query-result delivery, so a remote Gateway does not retain that lock across further database round trips. A separate read takes a fresh snapshot and rechecks current organization, account, membership, credential state, revocation and both deadlines before returning an identity. Renewal and expiry checks use database `clock_timestamp()`; both deadlines must be strictly in the future, and the absolute deadline remains unchanged. SQLite rejects equality at either deadline before renewal.

Login checks failure windows and records failed attempts against the current database clock after admission. A successful login derives its creation, idle, absolute and last-seen timestamps from one database instant after identity verification and locking. Waiting does not spend the new session's lifetime.

A successful validation uses two autocommit statements without a retained transaction or an authority cache. If the fresh authority read fails, no principal is returned even when renewal has committed. It does not acquire account locks after the session lock: account disable and deletion already lock the account before revoking sessions. The [browser retention decision](2026-10-24-browser-session-retention.md) continues to own cookie lifetime and clearing.

## Consequences

A queued administrator request sees a completed demotion and receives the existing forbidden response. An expired queued request receives the existing unauthorized response without renewed timestamps. Tokens, database columns, cookie syntax and response formats retain their existing representations. A validation admitted before a later authority change remains subject to the endpoint's existing execution checks and access invalidation; this change does not lock account authority through an entire HTTP response.

## Verification

Real Gateway HTTP regressions pause database result delivery and prove the session row is already available to another transaction. Changes to role, organization, membership, account status, credentials, revocation or deadlines during that pause affect the resumed request. Other regressions hold the login-session row, observe the validator's database lock wait, then commit a role demotion or move one deadline to the current database clock. The original implementation returns HTTP 200 for all three requests; the correction returns 403 for the completed demotion and 401 for either expiry. The role change uses the shipped user service, and the test owns its server, pool, temporary paths and request completion. No sleep determines the interleaving.

Two Date-only SQLite cases place each deadline exactly at validation time and verify refusal without timestamp renewal. The original implementation accepts both tokens.

A further HTTP lock barrier proves the original issuer records creation before lock release. Current cases verify post-admission issuance with the full configured idle lifetime, failed-attempt recording after its wait, and correct-password acceptance after the earlier failures expire while login is queued. Existing cross-Gateway cases retain lockout while failures are still within their window.

## Alternatives considered

**Keep identity joins in the locking query or wrap them in a materialized CTE.** Row-lock acquisition does not refresh unrelated account rows from the statement's earlier snapshot.

**Clamp the renewed expiry to the absolute deadline.** Clamping can write an expired timestamp while still returning an authorized identity; it does not reject the request.

**Lock account and membership rows after locking the session.** That reverses the account-to-session order used by disable and deletion and can introduce a deadlock.
