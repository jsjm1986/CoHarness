# Agent Note: Workspace document manager UI

Status: implemented

English | [中文](2026-08-17-workspace-document-manager.zh.md)

## Problem

The conversation input box accepts file uploads into the runtime's document workspace, but the browser UI provides no way to browse, organize, preview, upload, or delete previously uploaded documents. Users accumulate files with no management interface.

## Decision

Add a new Cordis plugin package `@deepseek-ai/dsh-client-ui-documents` that registers a **Documents** button in the `sidebar.footer.action` slot. Clicking opens a modal manager showing all documents in the current scope (personal or project runtime), powered by the existing `/api/documents` HTTP surface (`@deepseek-ai/dsh-host-userdoc-http` + `@deepseek-ai/dsh-userdoc-local`). `dsh-web-app` mounts the plugin in `cordis.patch.yml` and lists it in the bundle's `dependencies`, so `verify-cordis-config` can resolve the bare plugin name.

The manager uses the directory operations and `documents` storage layout owned by [document workspace folders and migration](2026-08-19-document-workspace-folders.md).

## Design

- **Package**: `packages/client/ui-documents/` follows the pattern of `ui-collaboration`: a `client/` subentry with browser-only plugin code, `tsdown.config.ts` for the client bundle, and `src/client/` for components.
- **Entry point**: `sidebar.footer.action` slot, alongside the scope selector from `ui-collaboration`. The button uses `IconBrowseOutline16` and a tooltip; the expanded sidebar shows the Documents label.
- **Modal**: a 960px `Modal` (full-width bottom sheet below 768px) with limits in `description`, folder breadcrumbs and rows, upload into the current folder, and create, rename, move, and empty-folder delete flows. Search, type, sort, paging, and batch delete are owned by [document manager filter, pages, and batch delete](2026-08-19-document-manager-filter-pages-batch.md). Compact document actions wrap below the name and retain 44px targets.
- **Preview**: routes by media type — images (`<img>`), PDFs (`<iframe>`), text-based files (fetch + `<pre>`, capped at 256 KiB), others fallback — in a matching-width dialog.
- **Delete**: confirmation dialog with a conversation-history warning; project-scope chrome (title and all-members extra) comes from fail-open `GET /account/api/context`.
- **Locale**: bilingual (zh/en) via `locales.ts`.
- **HTTP client**: this package owns a local `/api/documents` client. The client-bundle purity gate forbids a value import from `ui-conversation`, so the manager does not re-export conversation's client.

## Consequences

Users can browse real folders and preview, upload, move, download, and delete documents through the conversation UI. Personal and project runtimes remain isolated because each manager talks only to its current runtime's document root.

## Verification

- Package plugin test: verifies the plugin registers in `sidebar.footer.action` with `id: 'documents'` and `order: -10`.
- Component tests cover folder navigation and management, current-folder upload, document move, list controls, preview routes, delete confirmation, project chrome, and abort-safe load.
- Keyless Web e2e (`apps/web/tests/document-manager.e2e.ts`) pins desktop folder/list accessibility and compact 390×844 geometry.

## Alternatives considered

**Embed the manager inside the conversation composer.** Rejected because the composer is per-conversation state while uploaded documents are runtime-scoped and shared; a sidebar entry keeps the manager available across sessions and conversations.

**Add a gateway-side document API for cross-runtime management.** Rejected because each runtime owns its document root and `/api/documents` operations; centralizing would duplicate storage authorization and weaken scope isolation.
