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
- **Modal**: one bounded desktop workbench with scope navigation, folder breadcrumbs, direct attachment actions, and a removable inline preview. Phones use scope/action sheets, 44px controls, and full-screen reading. Sorting separates field and direction while preserving the six listing values owned by [document manager filter, pages, and batch delete](2026-08-19-document-manager-filter-pages-batch.md).
- **Auxiliary flows**: dialogs share scrollable content and pinned actions. Destination search only filters display; it retains the selected directory and the empty string denoting the root. Desktop scope selection keeps its confirmation step; compact scope navigation still switches immediately.
- **Preview**: image, PDF, and bounded text rendering reuse the authorized content reader. The selected preview is qualified by browsing scope and directory and remains visible only while its document is in the confirmed listing. This prevents a moved/deleted file or a previous scope from retaining active preview actions. Checkbox selection is independent; a single-file copy captures its own target instead of reading the batch selection. The [native PDF framing decision](../bug-fix/2026-10-23-native-document-pdf-framing.md) owns the authenticated PDF response policy.
- **Delete**: confirmation dialog with a conversation-history warning; project-scope chrome (title and all-members extra) comes from fail-open `GET /account/api/context`.
- **Locale**: bilingual (zh/en) via `locales.ts`.
- **HTTP client**: this package owns a local `/api/documents` client. The client-bundle purity gate forbids a value import from `ui-conversation`, so the manager does not re-export conversation's client.

## Consequences

Users can browse real folders and preview, upload, move, download, delete, and attach documents through one manager. Scope authorization and storage remain owned by the [Gateway document broker](../architecture/2026-10-15-gateway-local-document-broker.md); the workbench changes presentation and selection state only.

## Verification

- Package plugin test: verifies the plugin registers in `sidebar.footer.action` with `id: 'documents'` and `order: -10`.
- Component tests cover folder navigation and management, current-folder upload, document move, list controls, preview routes, delete confirmation, project chrome, and abort-safe load.
- Keyless Web e2e (`apps/web/tests/document-manager.e2e.ts`) pins desktop folder/list accessibility and compact 390×844 geometry.

## Alternatives considered

**Embed the manager inside the conversation composer.** Rejected because the composer is per-conversation state while uploaded documents are runtime-scoped and shared; a sidebar entry keeps the manager available across sessions and conversations.

**Add a gateway-side document API for cross-runtime management.** Rejected because each runtime owns its document root and `/api/documents` operations; centralizing would duplicate storage authorization and weaken scope isolation.
