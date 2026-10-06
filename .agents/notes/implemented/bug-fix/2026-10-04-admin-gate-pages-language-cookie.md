# Agent Note: Carry the admin language choice into gateway gate pages

Status: implemented

English | [中文](2026-10-04-admin-gate-pages-language-cookie.zh.md)

## Problem

The admin language seam lives in `localStorage`, which server-rendered pages cannot read. The gateway-owned gate pages — `loginPage`, `passwordPage`, `waitingPage`, `stoppedPage` in `gateway/src/html.ts`, plus the login/lockout/password-length errors and the `INSTANCE_STOPPED` JSON message emitted from `server.ts`/`proxy.ts` — were hard-coded Chinese, so an English-preference admin still hit a Chinese login before ever reaching the SPA.

## Decision

`setAdminLanguage` now also writes a `hgw_lang` cookie (`Path=/`, `SameSite=Lax`, not `HttpOnly` — only the client writes it). `html.ts` carries a small `GATE_COPY` zh/en dictionary with the same source-of-truth/parity shape as the admin dictionaries, a `gateLanguage(cookieHeader)` reader, and a `gateCopy(language)` translate seat; every gate page takes a language parameter and `layout` emits the matching `html lang`. `server.ts` and `proxy.ts` resolve the language per request from the Cookie header and pass dictionary-resolved error text instead of inline literals. Strings that ship over the wire from server modules (`node-config-fields` labels, archive/document fallback titles, push-notification bodies, the bootstrap console hint) stay Chinese — they are wire/operator data with no per-request preference, a product boundary rather than remaining debt.

## Files

- `gateway/admin-ui/src/language.ts` — `setAdminLanguage` writes `hgw_lang` beside `coharness-admin-language`.
- `gateway/src/html.ts` — `GatePageLanguage`, `GATE_LANG_COOKIE`, `gateLanguage`, `gateCopy`, `GATE_COPY` dictionary; all four pages localized.
- `gateway/src/server.ts` — login/lockout/invalid and password-length errors through `gateCopy`; both pages receive the request's language.
- `gateway/src/proxy.ts` — `stoppedPage`/`waitingPage` and the `INSTANCE_STOPPED` message through `gateLanguage`/`gateCopy`.

## Alternatives considered

**Keep the gate pages Chinese unconditionally.** Login, password, runtime-starting, and runtime-stopped are the first admin surfaces an operator sees; an English preference would still open on Chinese before the SPA could apply it.

**Swap the text client-side after load.** The gate pages are server-rendered HTML outside the SPA; a post-load replacement flashes Chinese first and still leaves the `INSTANCE_STOPPED` JSON message and login/lockout errors untranslated.

**Translate every server-emitted string.** `node-config-fields` labels, archive/document fallback titles, and push-notification bodies are wire or operator data with no per-request preference attached; the boundary is the server-rendered page, not every string the gateway produces.

## Consequences

With `hgw_lang=en` the login, password, runtime-starting, and runtime-stopped pages render in English — verified live against the gateway. A browser that never opened the admin selector defaults to Chinese, matching the localStorage default.
