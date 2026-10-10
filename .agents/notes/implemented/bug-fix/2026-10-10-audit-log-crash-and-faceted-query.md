# Agent Note: Audit log crash chain, failure-only api rows, and faceted admin audit

Status: implemented

English | [中文](2026-10-10-audit-log-crash-and-faceted-query.zh.md)

## Problem

An unbounded `/admin/api/audit?limit=` query returned roughly 1.4 million rows on one event loop. During the stall PostgreSQL killed a checked-out transaction client under `idle_in_transaction_session_timeout`; the client's `error` event had no listener and crashed the gateway process, which `launchd` then restarted. The table itself was 431 MB with a ~99.8% noise share of successful `api` rows — one row per proxied `/api/*` request — while steward SQL attempts lived only in `steward_query_log`, invisible to the console. `login.failed` stored a bare username string the projection dropped, `model.denied` carried structured fields the allowlist withheld, failed mutating admin calls left no row at all, and the console offered no family, outcome, actor-name, or total-count navigation.

## Decision

Crash chain: `connectFromPool` attaches a once-per-client `error` guard to every checkout, logging only an error code; `transaction`, `steward-query`, and its `explain` path now release with `release(error)` on failure so a dead backend is destroyed instead of lent out again. The audit endpoint clamps `limit` to 500, floors `offset` at 0, and rejects non-integer `userId`, unknown `family`/`outcome`, and `from > to` with HTTP 400.

Data model: successful `api` writes stop in `server.ts` and `proxy.ts`; only `status >= 400` rows persist, and migration `053` deletes historical successful `api` rows. The admin API wrapper catch records `admin.request` rows for failed mutating endpoints, so denials and errors are never silent. `login.failed` and `login.locked` write `{ username }` JSON instead of a bare string. `auditSummary` allows `username`, `model`, `provider`, `purpose`, `subject`, steward `classification`/`dryRun`/`rowCount`/`resultBytes`/`approvalId`, and `target`/`subject` coordinates while still withholding raw detail. Non-request rows previously defaulted to `outcome='success'` because the durable column derived only from HTTP status — `login.failed` rendered as a success badge. `auditOutcome` now derives the stored outcome from the status when present and the action's declared failure suffix (`.failed`/`.denied`/`.locked`/`.error`/`-failed`) otherwise; migration `054` reclassifies the historical rows.

Steward mirroring: `journal()` writes a bounded `audit_events` row for every attempt, and the write path inserts the mirror inside the write transaction so an audit-insert failure rolls the statement back. The statement text and error message stay in `steward_query_log`; the console sees classification, verdict, sizes, and the approval receipt. A denied write journals `denied` once — the outer catch no longer double-journals it as `error`.

Query surface: both stores accept `family` (admin/auth/model/steward/api/other), `outcome`, `actor` (username/display-name substring), `q` (literal action substring), and wildcard-escaped `actionPrefix`; `action` keeps honored-wildcard LIKE semantics. Rows join the actor's current username and display name, IP renders through `host(source_ip)`, and the endpoint sets `x-total-count` for paged totals. The console regroups the page into family tabs — Management, Authentication, Model denials, Maintenance channel, Failed requests, All — with actor/action/outcome/time filters, a refresh control, actor names, and total-aware pagination.

## Alternatives considered

**Keep successful `api` rows under a default filter.** Rejected: a ~1.4M-row polling trail is transport telemetry, not audit; retaining it spends write amplification on rows nobody pages through, and the failed-request subset preserves the forensic value.

**Project full steward statements into `audit_events`.** Rejected: the console allowlist exists to bound exposure; `steward_query_log` remains the authoritative journal with statement text, and the mirror carries only classified metadata.

**Cap the query without an `error` listener.** Rejected: the crash was the client's `error` event, not the slow query; a bounded limit alone leaves any mid-transaction kill able to terminate the process.

## Consequences

`pool.connect()` inside `pg.Pool.query` uses the callback form, so overriding `pool.connect` hangs every query — the guard must attach at the `connectFromPool` seam and callers holding a client across statements must `release(error)` on failure. Test doubles that are not `EventEmitter`s pass through the guard untouched. Legacy `api` rows disappear in migration 053; audit history before that deployment keeps only failure rows and business events. The admin console's `auditSummary` remains allowlist-bounded — new visible fields must be added there deliberately.

## Verification

`postgres.spec` terminates a checked-out backend mid-transaction and asserts the process survives and the pool recovers, and derives `outcome` from status or the action-name suffix; `steward.spec` asserts mirror rows equal journaled rows 1:1 with no statement text; `audit.spec` covers family/outcome/actor/escaped-substring filters — including failure rows that carry no HTTP status — clamped pagination, actor joins, and `count`; `admin-api.spec` covers 400s for invalid filters, `x-total-count`, username projection, and the single `admin.request` row for a failed delete. Migration 053 was pre-applied on the production database in batches before activation, so the registered migration landed as a no-op; migration 054 applied cleanly during activation.
