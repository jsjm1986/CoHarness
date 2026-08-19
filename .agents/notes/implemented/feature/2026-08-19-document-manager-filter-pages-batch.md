# Agent Note: Document manager filter, pages, and batch delete

Status: implemented

English | [中文](2026-08-19-document-manager-filter-pages-batch.zh.md)

## Problem

The workspace document manager listed every upload in one scrolling 560px card. On a desktop monitor the card wasted space; with dozens of files the date groups became a long unfiltered column with no type, sort, or paging controls, and deletion was one file at a time.

## Decision

The manager applies its filters, sorting, and 20-row pages to the documents returned for the current directory. Desktop chrome is a 960px card (`min-height` 640px, `max-height` 860px); compact remains a full-width bottom sheet. Checkboxes select across pages; **Delete selected** confirms, then calls `remove` once per id. Visibility copy states personal vs project sharing. Preview uses the same desktop size. Listing helpers live in `listing.ts`; `PAGE_SIZE` is a module constant, not a cordis.yml field.

This extends [the workspace document manager](2026-08-17-workspace-document-manager.md). Folder storage and HTTP behavior are owned by [document workspace folders and migration](2026-08-19-document-workspace-folders.md).

## Design

Filter chips map `mediaType` to `image` / `pdf` / `text` (including `application/json` and `application/xml`) / `other`. Date sort keeps first-seen date groups on the current page; name and size sorts flatten the page and show the date as secondary meta. The header checkbox toggles the current page; the selection `Set` survives paging and is pruned when query or type hides an id. A mid-batch `remove` failure stops the loop, keeps remaining ids selected, reloads the list, then shows `delete.error`. Compact and coarse pointers keep 44px targets on checkboxes, selects, and row actions.

## Alternatives considered

**Paginate `GET /api/documents` on the Host.** Rejected: the store is a per-runtime directory listing already returned in one payload, and the manager's search/type/sort need the full set. Adding offset/cursor would not shrink the client filter and would force a wire-format change.

**A multi-id DELETE query.** Rejected: sequential `remove` reuses the existing idempotent 404 path and progress UI; a batch route would duplicate authorization without a different failure model.

**Infinite scroll instead of numbered pages.** Rejected: the request was explicit paging (翻页), and a 20-row page plus a footer status is keyboard-reachable in the Modal footer without a virtualized list.

## Consequences

Desktop users get a wider file manager with type, sort, pages, and batch delete. A folder with many documents still reaches the browser in one response before local paging.
