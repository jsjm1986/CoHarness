---
description: "Workspace document manager UI: browse, preview, upload, and delete uploaded documents"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-documents

Workspace document manager for the CoHarness Web UI. Organize, preview, upload, move, download, delete, and add stored documents to the conversation input box.

English | [中文](README.zh.md)

Opening the document picker captures its destination Session. Switching panes while the dialog is open does not change which composer receives a selected document. Adding checks that this live composer accepts documents before any copy. Without a target, document management and explicit copies remain available. A target that becomes unavailable during transfer leaves completed copies intact; retrying adds the retained references without copying them again.

Private image, PDF and download URLs carry the Connection’s confirmed account and runtime, including native iframe and anchor requests. The picker captures its destination Runtime separately from the document location; personal documents retain their shared account-and-computer identity. Copy-and-attach requests carry the captured Runtime and original Session ID for server-side preflight. Resumable uploads resolve their route, scope, computer and account before creating the upload session; metadata and native chunk requests retain that address through completion.

A trash conflict keeps the active document visible and reports that an earlier document remains in trash. The deletion confirmation retains the failure message so the user can inspect the trash before retrying.

## Summary

Use `dsh-client-ui-documents` as the workspace document manager in the Web UI: organize folders, preview, upload, move, download, delete, and insert stored documents into the conversation input. The picker captures its destination Session when opened, so switching panes mid-dialog never sends a document to the wrong composer.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Scope isolation](#scope-isolation)
- [License](#license)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="installation"></a>
## Installation

This package is part of the `@deepseek-ai/dsh-client-ui-documents` bundle and is loaded automatically by the web-app profile.

<a id="usage"></a>
## Usage

The plugin adds a **Documents** button to the sidebar footer (alongside the workspace scope selector). The rail shows an icon with a tooltip; the expanded sidebar shows the Documents label beside the icon. Clicking it opens a manager dialog for the current scope (personal or project workspace).

As soon as the first editable composer paints, the browser starts loading the manager code in the background. An open request uses the same chunk and starts its load immediately if preparation has yet to begin. The manager requests its data and file-type artwork when opened. A standalone preview also loads the artwork on open. A generic file icon appears while artwork loads or if it is unavailable. A closable dialog appears if the manager takes longer to load. A failed open offers Retry.

The manager uses one shared workbench surface. Wide screens keep scope navigation and an inline reading pane; compact navigation opens a scope sheet, and phones open a full-screen preview with a back control and fixed actions. Phones and short landscape screens scroll directory actions and file rows below the manager header, retaining full touch targets. Their previews open in a separate dialog with scrolling actions and a readable media area. Clicking a document name previews it without changing checkbox selection. Closing the inline preview releases its width to the file list. Upload lands in the current folder, and the named information control shows deployment limits. Move and copy use searchable destination lists with complete names and unchanged destination values. Secondary dialogs keep confirmation controls outside the scrollable body and reveal new errors inside it without moving focus; the folder form submits from its footer or Enter.

Selecting another personal or writable project scope keeps the manager and the active conversation in place. Runtime-local reads follow the account-confirmed browsing runtime, independently of the captured attachment destination. The Gateway scope broker authorizes browsing, preview, download, upload, folder operations, move, trash, restore, and purge for that selected scope; read-only projects keep browsing and preview while write actions are disabled. Adding a document from a non-current scope copies a snapshot into the active conversation scope before attachment. The all-scope overview offers a target-scope chooser instead of uploading without a destination.

At the primary entry in multi-computer mode, **All accessible documents** shows responding computers' results while other indexes are still loading. The first page can reorder as more results arrive. Paging starts once the current set of responding computers is confirmed. Refresh to include a computer that becomes reachable again. Searching, changing scopes, or closing the manager cancels the pending overview.

The Workbench plugin supplies the document PDF reader with selectable text and zoom controls. Without that contribution, a browser advertising inline PDF support opens the authenticated content URL in its reader. A browser without inline support offers a download. The application reader uses the same URL, bounds its complete read by document metadata, and releases its request, bytes, and Worker when the document changes or the preview closes. The [document HTTP owner](../../host/userdoc-http/README.md#known-limitations-and-deferred-work) retains the type-specific response restrictions. Text and image previews keep their existing renderers. Phone preview actions align each icon above its wrapping label.

Document metadata reads retry a transient runtime-starting response using the server's `Retry-After` delay before surfacing a localized scope-unavailable message. Account-context JSON and document JSON are read through the shared streaming 16 MiB browser response budget before parsing. Upload and copy writes are not replayed automatically.

Scope and folder reads keep the last committed rows visible while a new result is loading. A list without entries shows one loading skeleton during a pending read; its empty-state message appears only after that read settles. The mounted manager keeps a bounded, scope-qualified metadata cache: entries fetched within 30 seconds render immediately without another list request, entries up to five minutes old render immediately while the manager revalidates them, and older entries are removed. Explicit refreshes and document mutations invalidate cached listings; transient revalidation failures keep the visible rows and expose a retryable error. A denied scope drops its cached rows, selection and preview, and disables writes without changing the conversation target. A successful read retry restores browsing; only a permission read started after denial can restore the applicable write controls. Older in-flight responses cannot undo the denial. The cache is page-memory only and never stores document bytes or survives a browser reload.

Reopening the manager resumes its source computer, folder, and search after account verification; an account or base-scope change discards cached locations. Filters entered during folder navigation or an alternate-scope selection apply after that destination commits; they neither cancel the selection nor query the previous scope. Location pages append without replacing earlier choices. Isolated project names load independently from each owning computer without delaying location pagination; an unresolved name displays the public project number. Mobile upload choices follow newly loaded locations and names. Computer labels describe the displayed source, while attachment mode separately names the destination conversation space and computer. Browsing never changes that conversation's Runtime. Partial attachment copies name failed sources and clear the batch selection so retrying does not repeat successful copies.

Select one or more rows and choose **Copy to another scope** to create a snapshot in a writable project or in personal documents. The manager shows only safe scope labels; Gateway performs authorization and streaming, resolves target name conflicts without overwriting, and reports each file independently. A copy into the active conversation scope can be attached to the composer as a durable, non-owning draft; a copy into another scope remains there until selected from that scope.

The composer’s Documents control opens the same manager, so a copy started from the input bar returns to that draft through the manager attach command.

Folder and document totals have distinct labels; navigation, file rows, and preview share one surface. On phones, the current folder is a heading beside a back control, followed by actions and a full-width search row. Unfiltered empty folders omit search, type/sort controls, and zero counts at every width. Each layout presents one upload action and one explicitly named New Folder action. The all-scope catalog puts its metadata-only description under the location selector, groups upload and refresh actions before search, and wraps source metadata within each row. Portrait phones keep the location selector below the manager header while the folder content scrolls. Pagination uses labeled 44px arrow buttons. Date-sorted rows show their date once in the group heading; short landscape rows retain the date within their metadata instead. Short landscape moves search, type, sort, and page selection into More so the initial document list remains visible. Focused inline filters remain available when the viewport shrinks and while focus moves between their controls and More. Short landscape management and previews use the full available surface with explicit back or close controls. Preview titles and Back remain visible while the media and actions scroll. Scope feedback and folder actions share rows where space permits; empty-state content and upload progress use compact rows while retaining full touch targets. Without a target conversation, management hides attachment actions; selection mode retains its destination guidance. Paginated rows remain in normal layout so their controls contribute their full height to the scrolling surface.

The manager can browse an authorized alternate personal/project source as safe metadata rows. Selecting a scope keeps the existing manager dialog mounted and does not open a second browser or modal window. Scope permissions determine which preview, download, upload, move, trash, restore, purge, folder, and attachment actions are enabled; a non-current attachment copies a snapshot into the active conversation scope. The all-scope view never exposes file bytes or host paths; each row can be copied into a writable target, with target-folder selection and folder creation.

Folder rows open the folder and expose Rename and Delete in More; deletion succeeds only for an empty folder. Document rows retain checkboxes, type icons, metadata, direct Add to conversation, and More with Preview, Move, Copy, Download, and Delete according to scope permissions. File icons use locally packaged [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) filename and compound-extension associations with MIME fallback; they do not determine file processing. Preview and single-file copy address the named file independently of other checked rows. Compact multi-selection keeps counted Add selected and management actions above the safe area; controls retain 44px targets.

Move, copy, folder editing and deletion confirmations, source and upload scopes, history, and upload information share an auxiliary dialog layout with actions outside the scroll region. Searchable native radio lists expose complete destination names; filtering retains the selected value, and the root remains a valid destination. Compact scope navigation still switches on activation. Open action and scope dialogs retain their search and selection across viewport changes; closing after a replaced invoker restores focus to the owning manager. Phones use a full-screen library with a compact header, complete file names above direct attachment actions, and labeled preview actions; destination tasks scroll above fixed confirmation controls. Folder forms retain Enter submission and do not summon the phone keyboard on entry. Closing the manager invalidates pending dialog openings; closing a copy dialog prevents late directory responses from changing a later dialog. Copy confirmation waits for its destination directories and folder creation.

Documents are filtered by name and type (image, PDF, text, other), sorted by date, name, or size with separate field and direction controls, and paged 20 rows; date groups apply only to date sort. Checkboxes select across pages; batch move and delete execute one request per id. The manager's Trash view lists recoverable documents, restores them with collision-safe naming, and permanently purges them after confirmation; the provider's retention policy supplies the expiry date. The default upload policy has no per-document size limit; the message count and aggregate limits remain deployment policy. Preview supports images, PDFs, and text-based files (text capped at 256 KiB); other types show a download fallback. When Gateway `GET /account/api/context` reports a project, the title uses that project name, the caption states member sharing, and delete confirmation adds the all-members warning; a missing collaboration route keeps personal chrome.

Uploads use one resumable session protocol on desktop and mobile. Small files use one chunk; larger files use 8 MiB chunks with per-chunk and final SHA-256 verification. A network interruption does not discard completed chunks: selecting the same file again resumes the session while it is retained by the runtime. The browser stores only opaque session metadata, never document bytes. When unfinished uploads reach the receiving limit, the manager explains that selecting a previous file resumes its retained session.

The manager accepts one upload batch at a time and uploads its files in order. Its published count and native progress bar advance only after the server returns a completed document reference. A separate status names the current file and its byte progress or finalization phase; the upload button keeps its action name. A failed file stops the remaining files; completed files remain stored. When the same view remains open, the manager refreshes the authoritative directory with its existing filters, sort, and page, retaining the published count and error if that read fails. Closing the manager or navigating elsewhere does not redirect accepted writes, and their callbacks cannot replace another view's rows or progress. Completed writes invalidate cached directory metadata for the next read. Retry the failed and unstarted files explicitly; completed files are not uploaded again automatically.

Upload results remain separate from file selection and visibility metadata. A partial failure separates the error from the affected file and unstarted count; completed documents remain browsable.

<a id="scope-isolation"></a>
## Scope isolation

Alternate-scope directory reads use the browser bundle's typed `browseScope` client. Compatibility with a Host that lacks the scope-browse route belongs to that HTTP client, which falls back to the transfer metadata route while preserving directory and paging arguments.

Managed personal documents belong to the account and computer, shared by that account's Runtime allocations there. Project documents belong to the project on its assigned computer. Runtime identity addresses execution; it does not create a separate personal document store.

Folders are real directories that the model can inspect through its ordinary filesystem tools. The backend API (`/api/documents`) is provided by `@deepseek-ai/dsh-host-userdoc-http` and `@deepseek-ai/dsh-userdoc-local`; the local backend documents legacy `uploads` migration in its [README](../../attachment/userdoc-local/README.md).

<a id="license"></a>
## License

Apache-2.0

<a id="model-experience"></a>
## Model Experience

### Document manager

#### What the model sees

The browser shows a Documents button in the sidebar footer. Opening it presents the active scope's document folders through `/api/documents`, with breadcrumb navigation, folder management, name and type filters, sort, 20-row pages, add-to-conversation, preview, move, download, trash, restore, purge, multi-selection, and upload into the current folder. Selecting another authorized scope keeps the manager mounted and routes the same metadata and lifecycle actions through the Gateway with that scope's permission; a non-current attachment is copied into the active conversation scope before acceptance.

#### Token effect

The manager is a client-only surface; it adds no conversation context and no tokens to model requests. Uploaded documents enter the model transcript only when a user attaches them to a message.

#### KV Cache effect

The manager reads and writes the same durable `/api/documents` store that conversation attachments use, so previously uploaded documents remain available across sessions without re-upload. Its short-lived browser metadata cache affects only list rendering and has no model KV-cache effect.

## Known Limitations and Deferred Work

- Preview is limited to images, PDFs, and text-based files; other media types show a download fallback.
- Text previews are capped at 256 KiB; larger text files require download.
- Deleting a document does not rewrite session history, so previously sent messages that reference the document can no longer retrieve its content.
- Cross-scope copies are snapshots, not live synchronization; project-to-project transfers are supported when both scopes are authorized.
- Current-folder and all-scope listings request bounded server pages with opaque cursors when the provider supports them; older providers remain usable through local paging. The manager keeps already fetched pages while the dialog stays mounted.
- Trashed documents remain recoverable only for the provider's retention window; purge is permanent, while active documents remain until deleted.
- Folder deletion is empty-only; the UI does not recursively delete a folder tree.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
