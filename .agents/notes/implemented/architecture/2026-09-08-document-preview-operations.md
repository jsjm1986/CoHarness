# Agent Note: Document preview and file addresses

Status: implemented

English | [中文](2026-09-08-document-preview-operations.zh.md)

## Problem

File viewers need different loading policies and may offer several implementations for one extension. A change stream cannot also express an on-demand read without mixing live data with callable capabilities. HTML dependencies additionally need the Host's filesystem authorization and path resolution, not the browser's current directory.

## Decision

File previews separate resource observation from content reads. The [resource model](2026-09-05-client-resource-model.md) shares observations by address: `source(request)` and `pin(request, signal)` take an identity-checked `WorkspaceResourceOpenRequest` — runtime target, Session, path, and address — and providers answer `stat(address, signal)` metadata only while the registry drives refresh through `handleChange` and `reload`. `source.get()` exposes only `{ status, value, error }`. Holds start and stop observation, not the underlying file or Session. Content reads use ordinary injected Preview callbacks.

[Workspace Files](../../../../packages/host/apiproxy/README.md) retains Host line reads and byte windows; complete reads are composed client-side from `stat` plus version-pinned `readBytes` windows, and reads relative to another file's directory are resolved client-side before the same authorized calls. The Host resolves every path through the Session filesystem; file reads inherit that backend's read authority, while directory listing and change observation stay workspace-scoped.

Readable files use `dsh-resource://file/session/<sessionId>/<path>` with a workspace-relative path; `workspaceResourceAddress` throws on absolute, scheme, or empty paths, and `source(request)` rejects a request whose Session or path does not match the encoded address. The provider and Preview readers take the Session only from that address, never from the current selection, first holder, or owning tab; a request whose Session workspace is unavailable reports `workspace-file/unknown-session`. Session authorization is a file-protocol rule, not an additional Resource identity.

The [workbench file tab](../../../../packages/client/ui-workbench/README.md) owns format selection and loading policy: `WorkspaceFileTab` routes each open request by extension to a fixed body — paged text, accumulated Markdown, packaged HTML, or the PDF/Office document body — inside the same authorized tab rather than through a renderer registry. Bodies receive the same `WorkspaceResourceOpenRequest`, the shared `useTabInfo` hook, and injected readers: `readPreview` for text pages, `readFileBytes` for complete bytes, `readBytesPreview` for the bounded binary fallback, and `readDocument` for authorized Office conversion. Refresh remains per tab, with no resource reload, shared `changed` acknowledgement, extra resource wrapper, or content Session. The [workbench HTML/Markdown previews note](../feature/2026-09-25-workbench-html-markdown-previews.md) owns the packaging and accumulation rules.

Markdown reuses the incremental primitives with cumulative paged text. HTML and PDF read complete `Uint8Array` data; Host transport remains base64. Published buffers are borrowed read-only and never persist into layout or Session JSON. PDF.js runs in an owned Worker with version-matched bundled font and decoder data, and copies input before transfer to preserve Preview's retained buffer. HTML runs in a Blob iframe with exactly `sandbox="allow-scripts"`, without same-origin, popup, form, download, or top-navigation privileges; replacing or unmounting the preview revokes the outer Blob URL. The browser retains its normal external-network rules. Bounded static local JS/CSS reads stay in the parent; the opaque frame creates its own asset Blobs, because it cannot load parent-origin Blobs. PNG, JPEG, GIF, WebP, AVIF, and SVG render through a `data:` URL in an `<img>` static-image context, so SVG markup never enters the application DOM and its scripts stay inert.

PDF.js's official TextLayerBuilder owns selection boundaries and copy normalization over the width-fitted canvas, with shared page cleanup and a component-owned resize observer. Responsive sizing uses the CSS `scale` property independently of PDF.js's page rotation and translation transforms. Its end-of-content marker and stacking rules constrain selection in blank regions; line-break highlighting is suppressed. Per-page cancellation uses the builder's cleanup rather than aborting the first page's signal, because the official selection listeners are shared across pages.

## Alternatives considered

**Load converted content through callbacks in preview metadata.** A callback makes the shared file store hold both original file bytes and format-specific conversion results. Renderer-owned loading keeps conversion caches, failures, and font metadata with the document body while preserving shared file identity and toolbar controls. The body owns its request lifetime, ignores stale reports after reload or replacement, and cancels pending work on unmount. Office retains settled contents for the tab lifetime.

**Methods attached to an Iterator or its values.** This conflates observation with commands and repeats capability identity in data frames. Frames carry data and failures; explicit Preview RPC callbacks perform reads.

**A core public-projection factory, or the same assembly inside `open`.** Separate stream values, operations bundles, and public interfaces add assembly without another current consumer that needs it. Preview's shared RPC adapter already keeps Session decoding and base64 out of renderers. Resource offers no provider-agnostic command interface or opening-bound command lifetime; adding either needs consumer evidence beyond file preview.

**UI Session as extra Resource identity, or authorization from the first holder or current selection.** A retained tab can belong to a different Session from the selected one, and the UI location does not identify the addressed file. Encoding the required Session in the file address preserves Host authorization while letting all readers of one address share observation.

**File-reading methods on every resource.** Chat and terminal resources have independent data and operation semantics; only observation registration and lifetime are common.

**A preview resource wrapper, content Session, or second resource Hook.** These duplicate addressing, cancellation, subscriptions, and ownership already provided by Resource and Workspace Files. Loading policy belongs to the preview owner.

**A local server, virtual host, or `file:` iframe.** These require extra hosting or filesystem authority. The preview is for static generated pages, not a complete application runtime; modules, dynamic filesystem requests, and arbitrary nested asset graphs are outside its support.

**Sanitize SVG into the application DOM or an iframe.** A sanitizer would add a second SVG parser and an evolving active-content policy before placing untrusted markup in an interactive document. The `<img>` static-image context preserves native SVG rendering and intrinsic dimensions without giving the markup a script-capable DOM.

## Consequences

Preview bodies can be replaced without changing the tab or file protocol. Full-file formats pay bounded whole-file memory and PDF adds bundled Worker/font/decoder bytes. Format selection and view state are page-local, not durable Session data. Preview owns RPC cancellation and native buffers independently of metadata observation. A tab retains its read version and the observation version captured at read start; refreshing it neither discards another tab's content nor clears its change notice. File reads remain non-transactional, and opaque versions are compared for equality, not ordering. The [recorded browser scenario](../../../../apps/web/tests/workspace-files.e2e.ts) exercises incremental text, Markdown rendering, the packaged opaque HTML frame, and the shared change/reload path; [workspace-office.e2e.ts](../../../../apps/web/tests/workspace-office.e2e.ts) covers the authorized Office body.
