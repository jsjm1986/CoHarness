# @deepseek-ai/dsh-client-ui-documents

Workspace document manager for the CoHarness Web UI. Browse, preview, upload, and delete documents uploaded through the conversation input box.

English | [中文](README.zh.md)

## Installation

This package is part of the `@deepseek-ai/dsh-client-ui-documents` bundle and is loaded automatically by the web-app profile.

## Usage

The plugin adds a **Documents** button to the sidebar footer (alongside the workspace scope selector). The rail shows an icon with a tooltip; the expanded sidebar shows the Documents label beside the icon. Clicking it opens a manager dialog for the current scope (personal or project workspace).

The dialog is a 560px card on viewports at least 768px wide and a full-width bottom sheet below that (the Modal portal cannot see the shell `data-viewport` stamp, so layout branches on `(max-width: 767px)` and `(pointer: coarse)`). Limits appear under the title. The toolbar is a search field, an upload control that opens the system picker and uploads immediately, and a refresh icon. On compact viewports the search occupies a full row and upload stretches beneath it. Desktop fine pointers may drop files onto the list; coarse pointers do not show a drop overlay.

Each row shows a file icon, ellipsized name, size, and Preview / Download / Delete. Compact and coarse pointers hide the action labels and enlarge the controls to the 44px touch target; accessible names still include the file name. Preview supports images, PDFs, and text-based files (text capped at 256 KiB); other types show a download fallback. When Gateway `GET /account/api/context` reports a project, the title uses that project name and delete confirmation adds the all-members warning; a missing collaboration route keeps personal chrome.

## Scope isolation

Documents are stored per-runtime scope:

- **Personal scope**: `$HOME/uploads/<YYYY-MM-DD>/<filename>`
- **Project scope**: `<project-directory>/uploads/<YYYY-MM-DD>/<filename>`

The backend API (`/api/documents`) is provided by `@deepseek-ai/dsh-host-userdoc-http` and `@deepseek-ai/dsh-userdoc-local`.

## License

MIT

## Model Experience

### Document manager

#### What the model sees

The browser shows a Documents button in the sidebar footer. Opening it presents a modal listing every document uploaded in the active scope (personal or project runtime) via the `/api/documents` surface, grouped by upload date, with per-row Preview, Download, and Delete actions, plus an upload control and a name filter.

#### Token effect

The manager is a client-only surface; it adds no conversation context and no tokens to model requests. Uploaded documents enter the model transcript only when a user attaches them to a message.

#### KV Cache effect

The manager reads and writes the same `/api/documents` store that conversation attachments use, so no separate cache exists and previously uploaded documents remain available across sessions without re-upload.

## Known Limitations and Deferred Work

- Preview is limited to images, PDFs, and text-based files; other media types show a download fallback.
- Text previews are capped at 256 KiB; larger text files require download.
- Deleting a document does not rewrite session history, so previously sent messages that reference the document can no longer retrieve its content.
- The document manager operates on the current runtime scope; switching between personal and project scope shows that scope's uploads only.
- The manager does not offer multi-select, sortable columns, folder trees, or type-filter chips.
