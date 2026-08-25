# @deepseek-ai/dsh-client-ui-documents

Workspace document manager for the CoHarness Web UI. Organize, preview, upload, move, download, delete, and add stored documents to the conversation input box.

English | [中文](README.zh.md)

## Installation

This package is part of the `@deepseek-ai/dsh-client-ui-documents` bundle and is loaded automatically by the web-app profile.

## Usage

The plugin adds a **Documents** button to the sidebar footer (alongside the workspace scope selector). The rail shows an icon with a tooltip; the expanded sidebar shows the Documents label beside the icon. Clicking it opens a manager dialog for the current scope (personal or project workspace).

The dialog is a full-height workbench on desktop and a compact full-screen workbench on phones. Desktop keeps the scope rail and inline actions; compact layouts use a current-scope trigger, a bottom scope sheet, and a More sheet for filters and secondary operations. Each sheet has one title row and one scrollport, while the document list remains the manager's only main scrollport. Upload is the primary compact toolbar action and uses a short visible label with a complete accessible name; uploads and desktop drops land in the current folder. A caption states personal vs project visibility and the filtered document count. Copy uses a metadata plan, target-folder selector, and per-file retry controls.

Selecting another personal or writable project scope keeps the manager and the active conversation in place. That view remains metadata-only for browsing, but its Upload action streams the selected files to the target scope root through the Gateway. Folder management, preview, download, move, delete, and attachment actions remain unavailable until the active runtime scope is restored. Read-only projects stay visible with an explicit permission state, and the all-scope overview offers a target-scope chooser instead of uploading without a destination.

Select one or more rows and choose **Copy to another scope** to create a snapshot in a writable project or in personal documents. The manager shows only safe scope labels; Gateway performs authorization and streaming, resolves target name conflicts without overwriting, and reports each file independently. A successful copy can be attached to the active composer as a durable, non-owning draft.

The composer’s Documents control opens the same manager, so a copy started from the input bar returns to that draft through the manager attach command.

The manager can browse an authorized alternate personal/project source as metadata-only rows. Selecting a scope keeps the existing manager dialog mounted and marks the view as read-only; it does not open a second browser or modal window. Alternate rows expose selection and copy, while preview, download, move, and delete stay bound to the active runtime store. The all-scope view never exposes file bytes or host paths; each row can be copied into a writable target, with target-folder selection and folder creation.

Folder rows open the folder and expose Rename and Delete; deletion is confirmed and succeeds only for an empty folder. Document rows show a checkbox, ellipsized name, size, date, and a single More action. The compact action sheet presents Add to conversation / Preview / Move / Download / Delete according to scope permissions. Add to conversation references the stored document directly, so it does not upload a duplicate. Move supports one document or the current selection and offers the root plus every folder as destinations. Compact multi-selection uses a safe-area-aware batch bar and action sheet; all compact controls keep 44px touch targets and long names cannot overlap.

Documents are filtered by name and type (image, PDF, text, other), sorted by date, name, or size, and paged 20 rows; date groups apply only to date sort. Checkboxes select across pages; batch move and delete execute one request per id. The default upload policy has no per-document size limit; the message count and aggregate limits remain deployment policy. Preview supports images, PDFs, and text-based files (text capped at 256 KiB); other types show a download fallback. When Gateway `GET /account/api/context` reports a project, the title uses that project name, the caption states member sharing, and delete confirmation adds the all-members warning; a missing collaboration route keeps personal chrome.

Uploads use one resumable session protocol on desktop and mobile. Small files use one chunk; larger files use 8 MiB chunks with per-chunk and final SHA-256 verification. A network interruption does not discard completed chunks: selecting the same file again resumes the session while it is retained by the runtime. The browser stores only opaque session metadata, never document bytes.

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

The browser shows a Documents button in the sidebar footer. Opening it presents the active scope's document folders through `/api/documents`, with breadcrumb navigation, folder management, name and type filters, sort, 20-row pages, add-to-conversation, preview, move, download, delete, multi-selection, and upload into the current folder. Selecting another writable scope adds an upload-only target view whose resumable requests go through the Gateway and land in that scope's root. Adding a row places its existing durable document id into the current conversation composer and closes the manager after acceptance.

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
- A completed document remains until the user deletes it; only abandoned, incomplete upload sessions expire automatically.
- Folder deletion is empty-only; the UI does not recursively delete a folder tree.
