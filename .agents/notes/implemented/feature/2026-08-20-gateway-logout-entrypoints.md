# Agent Note: Gateway logout entry points

Status: implemented

English | [中文](2026-08-20-gateway-logout-entrypoints.zh.md)

## Problem

Authenticated users could not end their Gateway session from either the Web workbench or the `/admin` application, even though the Gateway already owned a complete `POST /logout` route that revokes the token, records an audit event, clears the session cookie, and redirects to `/login`.

## Decision

Both browser surfaces submit a native same-origin `POST /logout` form. The `/admin` SPA renders the form in its desktop sidebar and compact mobile header. The Web workbench renders it from the Gateway-only `dsh-client-ui-collaboration` sidebar footer slot and only after the account context is available, so local unauthenticated Web mode does not expose a dead route. The browser does not duplicate token revocation or cookie handling; Gateway remains the sole session owner.

## Consequences

Logout behavior is identical in the user and admin applications, including audit and redirect semantics. Native form navigation works without a client-side fetch race or a second cookie-clearing implementation. A transient or unavailable account-context response hides the Web entry until the collaboration state is ready; `/admin` remains available through its own authenticated document.

## Alternatives considered

**Client-side `fetch('/logout')` followed by manual navigation.** Rejected because it duplicates redirect and session-cleanup behavior, complicates browser history and failure handling, and can leave stale UI state while the request settles.

**Add a new logout API or cookie-clearing helper.** Rejected because Gateway already exposes the authoritative revocation, audit, and cookie contract at `POST /logout`.

**Always show the Web logout button in local mode.** Rejected because local Web has no Gateway session route; the collaboration account-context state is the existing Gateway-only capability signal.
