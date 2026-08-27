# Agent Note: Cross-scope document catalog and workbench

Status: implemented

English | [中文](2026-08-24-cross-scope-document-workbench.zh.md)

## Problem

Documents lived only in the active runtime and the Gateway transfer path knew only about personal-to-project copies. Project-to-project copies, ownership-aware mutations, all-scope metadata, reliable lineage, and an independent administrator view therefore had no durable source of truth.

## Decision

Migration 012 adds an organization-scoped metadata catalog, operation items, and append-only history. Runtime roots continue to own file bytes and paths. Host document routes reconcile metadata after listings and writes, while signed Gateway runtime routes derive the current scope from the authenticated runtime identity. Unknown project ownership fails closed for destructive mutations.

The transfer broker accepts authorized personal/project pairs, including project-to-project copies. A short-lived metadata plan is consumed by commit; retries recheck authorization and preserve per-file outcomes. Target folders are listed or created through the target runtime, and administrator fan-out is restricted to organization administrators. The browser receives metadata only for the all-scope overview and can enter a scope or create a snapshot before previewing content.

The Web manager is a full-height overlay with a scope rail, metadata-only overview, target-folder copy flow, and current-scope history. Selecting a personal or project scope keeps that one overlay mounted and changes its content to the selected scope's authorized browser; read-only memberships disable writes while writable scopes expose folder and document lifecycle actions. It does not create a nested dialog or browser window. Admin has a separate Documents route with metrics, filters, metadata table, lineage/history detail, ownership transfer, and explicit metadata-delete confirmation.

## Alternatives considered

**Keep a per-runtime in-memory catalog.** Rejected because it disappears on restart, cannot power an organization-wide Admin view, and makes ownership and lineage impossible to audit across project runtimes.

**Expose alternate runtime paths to the browser.** Rejected because a path is not portable across runtimes and would turn a metadata picker into a cross-scope file disclosure channel.

**Synchronize documents live between scopes.** Rejected because it obscures ownership, creates conflict semantics, and is unnecessary for the requested personal-to-collaborative workflow; copies are explicit snapshots.

## Consequences

Legacy files are attributed lazily when a runtime listing reaches the catalog; historical rows retain a legacy marker. Catalog outages do not block ordinary uploads, but project destructive actions fail closed until ownership is synchronized. Snapshot copies never become live links. Releases after migration 012 are the only valid rollback targets because an older release cannot understand the new schema.

## Verification

Focused Gateway transfer/catalog tests, host user-document tests, client document tests, Admin UI tests/build, repository typecheck, and contract lint pass locally. PostgreSQL integration remains skipped when `HGW_TEST_DATABASE_URL` is absent.
