# Agent Note: Browser retention for sliding Gateway sessions

Status: implemented

English | [中文](2026-10-24-browser-session-retention.zh.md)

## Problem

Database idle expiry slides when an active user authenticates. A browser cookie that expires at the original idle deadline discards the token while its database session remains valid, forcing active users to sign in early. Rounding a supported sub-second lifetime down also emits an immediately expiring cookie.

The project-scope cookie also rounded its absolute lifetime down. A supported sub-second setting therefore removed the selected project immediately even while the login token remained usable.

## Decision

Issued session and scope cookies use the configured absolute lifetime, rounded up to whole seconds. PostgreSQL remains authoritative for both sliding idle expiry and the original absolute deadline. Clearing a session cookie emits `Max-Age=0`. Browser retention does not renew or revive either database deadline.

## Alternatives considered

**Retain the cookie only for the idle lifetime.** Database renewal cannot update a browser's independently fixed cookie deadline.

**Refresh the cookie on each HTTP response.** Activity through WebSockets would need a separate renewal mechanism. Absolute retention covers both transports without depending on response-header renewal.

**Extend the server's absolute deadline on activity.** That removes the configured limit on how long one login can authorize requests.

## Consequences

Active browser sessions retain their token through the server's allowed absolute lifetime. Idle and absolutely expired tokens remain unauthorized even when a client still sends them. Cookies issued before deployment keep their existing browser deadline until another sign-in. Real HTTP snapshots use a Date-only fake clock to cover active renewal, idle and absolute refusal, sub-second retention, and logout clearing without wall-clock sleeps. Operators can review the [upgrade instructions](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/browser-session-retention/guide.md).

A real project-selection HTTP scenario checks scope-cookie retention under a 900 ms absolute lifetime, the subsequent selected-project request and refusal after server expiry. Its runtime startup is controlled; the actual Gateway authentication, project service, scope selection and request context remain assembled.
