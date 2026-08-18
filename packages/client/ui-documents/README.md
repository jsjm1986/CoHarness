# @deepseek-ai/dsh-client-ui-documents

Workspace document manager for the CoHarness Web UI. Browse, preview, upload, and delete documents uploaded through the conversation input box.

English | [中文](README.zh.md)

## Installation

This package is part of the `@deepseek-ai/dsh-client-ui-documents` bundle and is loaded automatically by the web-app profile.

## Usage

The plugin adds a **Documents** button to the sidebar footer (alongside the workspace scope selector). Clicking it opens a modal that shows all documents uploaded in the current scope (personal or project workspace).

Each document row shows the name, size, upload date, and available actions: **Preview**, **Download**, and **Delete**. The preview supports images, PDFs, and text-based files; other types show a "not supported" fallback. Uploading a new document in the manager makes it immediately available for attaching to a conversation message.

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