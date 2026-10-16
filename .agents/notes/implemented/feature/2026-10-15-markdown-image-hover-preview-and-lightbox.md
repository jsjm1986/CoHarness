# Agent Note: Markdown images gain hover previews and the shared lightbox

Status: implemented

English | [中文](2026-10-15-markdown-image-hover-preview-and-lightbox.zh.md)

## Problem

Settled assistant prose rendered only absolute HTTP(S) images; every local destination — workspace files, temporary screenshots, remote-provider paths — stayed inert alt text, and file links to images offered no glanceable affordance. Upstream sources: `7fe9c06fa64125c97026c0b958b19675312358de` and its review fix `48392399545`, plus the route commits `7a715e79192`, `f81c5072bdd`, `4b009e7f942`, `ead14339bc2`, and `cb3df20cf3c` (all inside alpha.2); the desktop-only `ui-workbench` document-preview wiring from `7f0a53dfb33` and `e127ed2d6cd2` stays outside this change.

## Decision

The host side reuses the file-display route already recorded in [the filesystem-reads note](2026-09-08-file-display-through-filesystem.md): `api/gateway` mounts `GET|HEAD /api/file` through `connection.http.handlePrefix` with trusted-host authority, reads through `ctx.fs` bounded by `ctx.attachments.imageLimits.maxImageBytes`, and answers with `private, no-store`, `nosniff`, and a sandbox CSP. The gateway owns this route because it already registers trusted `/api` transport and imports the connection host face; placing it in `host/apiproxy` would close a project-reference cycle with `client/connection`.

`ui-primitives` owns the presentation seam. `ImageLightbox` moved here from `ui-attachment` as the shared original-image modal (focus restoration, Escape dismissal); `ImagePreview` is its internal contained-thumbnail renderer. `MarkdownDelegateProvider.fileImages` carries a decoded-path resolver plus complete labels: settled image file links render an inline `HoverCard` thumbnail after pointer dwell or keyboard focus, standalone local images render as contained buttons that open the lightbox, and image-only anchors keep their single navigation target. A load or decode failure swaps the image for a localized `Image preview unavailable · <alt or destination>` line. The renderer's `pathImages`/`fileMentions` streaming gate is unchanged: neither vocabulary applies to frozen streaming blocks.

The parser recovers authored local images whose bare-space paths micromark would otherwise split — only complete, unescaped, standalone paragraphs whose destination is an absolute or `./`/`../`-relative path with an unambiguous supported image suffix; code and ambiguous destinations stay literal. Angle-bracketed destinations need no recovery because CommonMark parses them natively.

`ui-conversation` wires the seam: `ChatView` supplies `fileImages` resolving through `fileMediaUrl` against `document.baseURI`, and `AssistantMarkdown` maps absolute local destinations through the same route via `localPathMediaUrl`, including workspace-relative paths resolved against the Session `cwd`. `ui-attachment` now imports the shared `ImageLightbox`. The deliverables system-prompt section teaches the model `![Description](<path>)` inline images, `[Description](<path>)` hover-preview links, and angle-bracket destinations.

## Alternatives considered

**Serving through `host/apiproxy`.** Rejected on project topology: `client/connection`'s host face references `apiproxy`, so a route there references the connection host face back and the TypeScript graph becomes cyclic.

**Image-only endpoints or blob/data URL negotiation.** Both already rejected by the paired notes: one authenticated file route serves every readable MIME type, and a synchronous render pass needs a stable URL without an asynchronous capability round trip.

**Recovering every space-containing destination.** Rejected: the recovery pattern accepts only standalone image paragraphs with unambiguous image suffixes, so prose like `` `![x](a b.png)` `` in code and genuine ambiguous destinations keep literal text instead of guessing at files.

## Consequences

Model prose that names a workspace file — including paths with spaces, Unicode, `#`, or `%` — displays through the authenticated route; destinations outside the workspace but readable by the composed provider display identically. Unauthenticated `/api/file` requests reject, HTML/SVG served through it cannot execute on the API origin, and oversized files stop at the 20 MiB attachment cap. Markdown in seats without `fileImages` (tool cards, trajectory) keeps inert alt text. The model now emits the syntax the renderer supports; the older "include a file link for clients without inline-image support" guidance is gone.

## Verification

`packages/api/gateway/tests/media-references.host.spec.ts` covers registration authority, the inclusive byte cap and 413, sparse-1 GiB preflight rejection, post-stat growth, Range ignored, metadata-only HEAD, malformed/missing/directory paths, outside-cwd and symlink reads, opaque remote targets, provider-failure propagation, socket-close abort, and disposal. `ui-primitives` specs cover `ImagePreview`/`ImageLightbox` states, image-only paragraphs, remote and local rendering, protocol revalidation, and failure text; `ui-conversation` specs cover the `fileImages` and `pathImages` wiring. `apps/web/tests/markdown-images.e2e.ts` drives the shipped composition: remote loads without referrer, workspace and outside-workspace files through `/api/file`, encoded and spaced paths, 413/404/corrupt fallbacks, lightbox open/close, hover and keyboard preview, viewport non-overlap, unauthenticated 401, active-content sandbox isolation, and image-link activation reaching `host.openPath` — the single-session composition mounts no workspace preview surface, so the gesture keeps its ordinary Host-open target.

## Related

- [Session prose local media display](2026-09-07-session-prose-local-media-display.md) — owns the renderer vocabulary decision.
- [Authenticated file display through filesystem](2026-09-08-file-display-through-filesystem.md) — owns the serving policy this route implements.
