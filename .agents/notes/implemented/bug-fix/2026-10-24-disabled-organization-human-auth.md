# Agent Note: Disabled organization human authentication

Status: implemented

English | [中文](2026-10-24-disabled-organization-human-auth.zh.md)

## Problem

Gateway readiness does not establish an organization's current status for later human requests. Checking only users and memberships permits new logins and existing cookies to authorize requests after the organization is disabled.

## Decision

PostgreSQL human authentication requires an active organization at the initial login lookup, the identity recheck after password verification, and every cookie validation. Refusal uses the existing invalid-login or unauthenticated response without exposing organization status. The post-verification check also rejects an organization disabled while password verification is pending.

## Alternatives considered

**Rely on startup readiness.** A running Gateway must observe status changes without a restart.

**Check only new logins.** Previously issued cookies would continue to authorize requests for disabled organizations.

## Consequences

Disabling an organization prevents subsequent human authentication through login and cookie validation. This check does not permanently revoke stored sessions: an unexpired session may authorize requests again if the organization is reactivated. Cancellation of already admitted traffic remains owned by the [access invalidation mechanism](../architecture/2026-09-22-cross-gateway-access-invalidation.md). Real HTTP/PostgreSQL regressions cover new logins, existing cookies, and organization disablement during password verification.

The combined organization checks and [locale-aware login keys](2026-10-23-case-insensitive-login-admission.md) measure as follows under plain Node 25.8.1, macOS arm64 and PostgreSQL 17.6 over loopback TCP, with one active member, pool size one, three fresh processes per variant and three batches per process. Cookie batches contain 200 calls; login batches contain 20. Median cookie validation is 2.574 → 2.547 ms/call, with peak and post-GC RSS 80,048 → 79,904 KiB. Login is 27.712 → 28.604 ms/call, with peak RSS 88,864 → 90,880 KiB and post-GC RSS 88,800 → 90,880 KiB. The login path adds one database normalization query. The diagnostic excludes HTTP transport, database-server memory and concurrent load. After building Gateway, run `TSX_TSCONFIG_PATH=tsconfig.run.json node --import tsx/esm tests/auth-admission.perf.ts` from its directory with `HGW_TEST_DATABASE_URL` selecting a disposable database; the baseline removes only these checks from the emitted module.
