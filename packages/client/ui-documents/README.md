# @deepseek-ai/dsh-client-ui-documents

Workspace document manager for the CoHarness Web UI. Organize, preview, upload, move, download, delete, and add stored documents to the conversation input box.

English | [中文](README.zh.md)

## Installation

This package is part of the `@deepseek-ai/dsh-client-ui-documents` bundle and is loaded automatically by the web-app profile.

## Usage

The plugin adds a **Documents** button to the sidebar footer (alongside the workspace scope selector). The rail shows an icon with a tooltip; the expanded sidebar shows the Documents label beside the icon. Clicking it opens a manager dialog for the current scope (personal or project workspace).

The dialog is a full-height workbench on desktop and a responsive sheet on small screens. A scope rail switches between personal documents, every joined project, and a metadata-only **All authorized scopes** view while preserving the conversation behind the overlay. A breadcrumb follows the current folder. The toolbar contains name search, type and sort selects, New Folder, upload, refresh, and current-scope history; uploads and desktop drops land in the current folder. A caption states personal vs project visibility and the filtered document count. Copy uses a metadata plan, target-folder selector, and per-file retry controls.

Select one or more rows and choose **Copy to another scope** to create a snapshot in a writable project or in personal documents. The manager shows only safe scope labels; Gateway performs authorization and streaming, resolves target name conflicts without overwriting, and reports each file independently. A successful copy can be attached to the active composer as a durable, non-owning draft.

The composer’s Documents control opens the same manager, so a copy started from the input bar returns to that draft through the manager attach command.

The manager can browse an authorized alternate personal/project source as metadata-only rows. Selecting a scope keeps the existing manager dialog mounted and marks the view as read-only; it does not open a second browser or modal window. Alternate rows expose selection and copy, while preview, download, move, and delete stay bound to the active runtime store. The all-scope view never exposes file bytes or host paths; each row can be copied into a writable target, with target-folder selection and folder creation.

Folder rows open the folder and expose Rename and Delete; deletion is confirmed and succeeds only for an empty folder. Document rows show a checkbox, ellipsized name, size, and Add to conversation / Preview / Move / Download / Delete. Add to conversation references the stored document directly, so it does not upload a duplicate. Move supports one document or the current selection and offers the root plus every folder as destinations. Compact layouts wrap document actions below the name so 44px touch targets and long names cannot overlap; the 320px toolbar uses explicit search/filter/action tracks so refresh stays aligned with the primary actions.

Documents are filtered by name and type (image, PDF, text, other), sorted by date, name, or size, and paged 20 rows; date groups apply only to date sort. Checkboxes select across pages; batch move and delete execute one request per id. The default upload policy has no per-document size limit; the message count and aggregate limits remain deployment policy. Preview supports images, PDFs, and text-based files (text capped at 256 KiB); other types show a download fallback. When Gateway `GET /account/api/context` reports a project, the title uses that project name, the caption states member sharing, and delete confirmation adds the all-members warning; a missing collaboration route keeps personal chrome.

## Scope isolation

Documents are stored per-runtime scope:

- **Personal scope**: `$HOME/documents/`
- **Project scope**: `<project-directory>/documents/`

Folders are real directories that the model can inspect through its ordinary filesystem tools. The backend API (`/api/documents`) is provided by `@deepseek-ai/dsh-host-userdoc-http` and `@deepseek-ai/dsh-userdoc-local`; the local backend documents legacy `uploads` migration in its [README](../../attachment/userdoc-local/README.md).

## License

MIT

## Model Experience

### Document manager

#### What the model sees

The browser shows a Documents button in the sidebar footer. Opening it presents the active scope's document folders through `/api/documents`, with breadcrumb navigation, folder management, name and type filters, sort, 20-row pages, add-to-conversation, preview, move, download, delete, multi-selection, and upload into the current folder. Adding a row places its existing durable document id into the current conversation composer and closes the manager after acceptance.

#### Token effect

The manager is a client-only surface; it adds no conversation context and no tokens to model requests. Uploaded documents enter the model transcript only when a user attaches them to a message.

#### KV Cache effect

The manager reads and writes the same `/api/documents` store that conversation attachments use, so no separate cache exists and previously uploaded documents remain available across sessions without re-upload.

## Known Limitations and Deferred Work

- Preview is limited to images, PDFs, and text-based files; other media types show a download fallback.
- Text previews are capped at 256 KiB; larger text files require download.
- Deleting a document does not rewrite session history, so previously sent messages that reference the document can no longer retrieve its content.
- Cross-scope copies are snapshots, not live synchronization; project-to-project transfers are supported when both scopes are authorized.
- Listings have no server-side pagination; each current folder is returned in one response and documents are paged in the browser.
- Folder deletion is empty-only; the UI does not recursively delete a folder tree.
