# Agent Note: Account administration retains current actor authority

Status: implemented

English | [中文](2026-10-28-user-administration-authority.zh.md)

## Problem

Browser authentication can finish before an administrator loses authority. A later account mutation can retain that earlier role through target lookup, password hashing or a database lock wait. Account deletion can also stop another user's Runtime before its data transaction rejects the administrator.

## Decision

The [administrator router](../../../../gateway/src/admin-api.ts) passes its server-authenticated actor into account creation, field updates, password resets and deletion. Request fields cannot supply this identity. [PostgreSQL account mutations](../../../../gateway/src/postgres/user-service.ts) lock the available organization before checking the current active nondeleted account, active membership and administrator role after password hashing and transaction admission. Organization, account and membership share locks retain the accepted authority until commit. The SQLite adapter checks its current active administrator inside an immediate transaction. Optional actor omission permits trusted bootstrap and internal maintenance.

Actor-bearing management admission also requires an existing password record with no required change pending. PostgreSQL helpers read this qualification on the existing transaction connection after blocking authority lookups; the SQLite adapter checks its user-row flag in the immediate transaction. A password reset committed before admission refuses queued account, model, project and lifecycle management without granting authority from the earlier browser object. Already admitted mutations may complete; password qualification adds no retained credential-row lock. Transport authentication and session expiry remain with the browser authentication owner. Trusted bootstrap retains its documented actor omission.

Creation authorizes before account insertion and directory allocation. Profile fields commit together; rejected updates preserve credentials and account data. Password reset authorizes after hashing and before credential replacement or session revocation. Existing self-deletion refusal, last-administrator protection, logical deletion and retained username rules remain owned by the [deletion decision](../feature/2026-08-16-gateway-user-logical-deletion.md).

Deletion supplies the actor to both [`withStopped`](../../../../gateway/src/instances.ts) and the final account transaction. Initial admission precedes queued-start cancellation and termination. The [destructive operation owner](2026-10-28-project-deletion-lifecycle.md) continues to exclude replacement generations while data work settles. Database connections are released before supervision and accounting, preserving one-connection compositions. Revocation after an approved stop can refuse the account deletion while retaining a stopped account and its files.

The [browser authentication decision](2026-10-24-browser-authentication-lock-waits.md) governs session validation and expiry. Mutation admission defines when these account writes are authorized; a completed mutation does not retain administrator authority for later independent requests.

## Alternatives considered

**Check the cached browser role again.** The earlier object cannot establish current database authority.

**Authorize before hashing or transaction admission.** The administrator can lose authority during either wait.

**Keep the authority transaction open through Runtime termination.** Supervision and accounting need their own database operations; a one-connection pool can deadlock.

## Consequences

Valid requests delayed past revocation return403 before account effects. Data refusal after an authorized stop does not promise to undo that stop. Custom service compositions propagate the optional actor parameters instead of relying on the browser object. General administrator instance controls and other administrative capabilities retain their own admission requirements.

## Verification

Authenticated Gateway transcripts exercise current and revoked actors against real PostgreSQL and SQLite data and an observable synthetic Runtime carrier. Store regressions cover all seven mutation methods and queued creation, profile mutation, deletion and password reset. These checks use no model API and do not establish native Windows supervision.
