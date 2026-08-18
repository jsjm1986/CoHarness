# Agent Note: Workspace document manager UI

Status: implemented

English | [中文](2026-08-17-workspace-document-manager.zh.md)

## Problem

The conversation input box accepts file uploads that land in the runtime's `uploads/` directory, but the browser UI provides no way to browse, preview, upload, or delete previously uploaded documents. Users accumulate documents with no management interface.

## Decision

Add a new Cordis plugin package `@deepseek-ai/dsh-client-ui-documents` that registers a **Documents** button in the `sidebar.footer.action` slot. Clicking opens a modal manager showing all documents in the current scope (personal or project runtime), powered by the existing `/api/documents` HTTP surface (`@deepseek-ai/dsh-host-userdoc-http` + `@deepseek-ai/dsh-userdoc-local`). `dsh-web-app` mounts the plugin in `cordis.patch.yml` and lists it in the bundle's `dependencies`, so `verify-cordis-config` can resolve the bare plugin name.

The backend capability (`ctx.userDocs.list`, `save`, `remove`, `stat`, `read`) already existed and was fully wired. The only gap was the browser UI.

## Design

- **Package**: `packages/client/ui-documents/` follows the pattern of `ui-collaboration`: a `client/` subentry with browser-only plugin code, `tsdown.config.ts` for the client bundle, and `src/client/` for components.
- **Entry point**: `sidebar.footer.action` slot, alongside the scope selector from `ui-collaboration`. The button uses `IconBrowseOutline16` and a tooltip; the expanded sidebar shows the Documents label.
- **Modal**: a 560px `Modal` (full-width bottom sheet below 768px) with limits in `description`, a search/upload/refresh toolbar, a date-grouped scrolling list, and per-row Preview, Download, and Delete. Choosing files uploads immediately; fine pointers may drop files onto the list. Compact and coarse pointers use 44px icon actions whose accessible names include the file name. Portal CSS branches on `(max-width: 767px)` and `(pointer: coarse)` because the dialog is body-portaled and never sees the shell `data-viewport` stamp.
- **Preview**: routes by media type — images (`<img>`), PDFs (`<iframe>`), text-based files (fetch + `<pre>`, capped at 256 KiB), others fallback — in a matching-width dialog.
- **Delete**: confirmation dialog with a conversation-history warning; project-scope chrome (title and all-members extra) comes from fail-open `GET /account/api/context`.
- **Locale**: bilingual (zh/en) via `locales.ts`.
- **HTTP client**: this package owns a local `/api/documents` client. The client-bundle purity gate forbids a value import from `ui-conversation`, so the manager does not re-export conversation's client.

## Consequences

Users can now browse, preview, upload, and delete documents through the conversation UI. The storage layout is unchanged — documents remain in the runtime's `uploads/` directory, isolated per scope. No new backend API or database migrations were needed.

## Verification

- Package plugin test: verifies the plugin registers in `sidebar.footer.action` with `id: 'documents'` and `order: -10`.
- Component tests: button open/close, list grouping, search empty state, picker and drop upload with progress, project title and delete extra, preview routes, and abort-safe load.
- Keyless Web e2e (`apps/web/tests/document-manager.e2e.ts`): desktop aria golden plus compact 390×844 bottom-sheet geometry (search stacked above upload, 44px row actions, last row inside the dialog).

## Alternatives considered

**Embed the manager inside the conversation composer.** Rejected because the composer is per-conversation state while uploaded documents are runtime-scoped and shared; a sidebar entry keeps the manager available across sessions and conversations.

**Add a gateway-side document API for cross-runtime management.** Rejected because uploads already live in the runtime's own `uploads/` directory and the existing `/api/documents` surface fully covers list/upload/remove; centralizing would duplicate storage and authorization.