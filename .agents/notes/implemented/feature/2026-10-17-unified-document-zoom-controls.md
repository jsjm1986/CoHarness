# Agent Note: Unified document zoom controls

Status: implemented

English | [中文](2026-10-17-unified-document-zoom-controls.zh.md)

## Problem

PDF and converted Office previews rendered at fit width only, and image previews had no zoom at all. Upstream unified the surface: one control set, one scrollport, and one preference model shared by PDF, converted Office, raster, and SVG bodies.

## Decision

A `zoom` layer inside `ui-workbench` supplies `ZoomViewport` and `ZoomControls` plus the shared `ZoomPreference` model (`fit-width` or a fixed 25%–400% scale in 25% steps, with presets of fit, 25%, 50%, 100%, 150%, and 200%). `ZoomViewport` owns its own scrollport, so fixed zoom scrolls inside the document surface and never disturbs the file/text scroller; `fit-width` tracks pane resizing without upscaling content smaller than the pane. PDF 100% means the 96-DPI page size and image 100% means the intrinsic CSS-pixel width. Pointer-anchored Ctrl+wheel and trackpad pinch gestures zoom live.

Zoom preferences live on the containing tab's `view` object — `pdfView.zoom` for documents and `fileView.zoom` for images — so a preference survives hidden-body remounts and dies with the tab, matching this fork's tab-owned view state instead of upstream's standalone store. Because the lazy `client.pdf.js` chunk cannot synchronously require modules shared with the eager entry (the module system resolves `require` edges non-async), `WorkspaceDocumentPreview` passes `ZoomViewport` and the surface class to `PdfBody` through props; the PDF pages render through temporary canvases and republish at device-pixel-ratio multiplied by zoom after the gesture settles, keeping the old bitmap until its replacement lands.

`WorkspaceFilePreview` dispatches on the image extension before attempting the text reader: image files read bytes directly, because a text-decodable payload such as SVG must still render as an image, not as source text. Images stay a single `<img>` — preserving animated-image continuity — and SVG keeps its inert `data:`-URL rendering context documented in [document preview operations](../architecture/2026-09-08-document-preview-operations.md). Text, Markdown, HTML, and spreadsheet previews keep no zoom controls. Controls reveal only for fine-pointer devices inside the bottom 72 CSS pixels, stay visible under hover, focus, an open menu, or a gesture, and hide after a 420 ms leave delay; coarse-pointer devices keep them visible.

## Alternatives considered

**Upstream's standalone zoom store.** Upstream keeps preferences in a per-tab store reached through `useTabInfo`. The fork already gives each file tab a mutable `view` record owned for the tab's life; writing `view.zoom` carries identical retention semantics without adding a second store channel to the workbench.

**Let the PDF chunk import the zoom layer.** A static import edge would make rolldown split a shared `client.ZoomViewport` chunk that the eager entry then synchronously requires, which the module system cannot satisfy. Prop injection keeps the chunk boundary exactly where it was.

**Route SVG through the text reader's `not-text` fallback.** The fallback exists for unrecognized binary payloads; routing a known image extension through a guaranteed-failing read adds a wasted round trip and hides the image intent. Extension dispatch selects the bytes reader directly, with the fallback retained for unmapped binary files.

## Consequences

- `packages/client/ui-workbench/src/client/zoom/` holds the shared layer; `PdfBody` and `PreviewImage` are its two consumers.
- `WorkspaceFileTab` grows `pdfView.zoom`/`fileView.zoom` plus localized zoom labels; `document.ts` readers keep their contracts.
- Web e2e covers Office zoom (reveal/hide, fixed scale, horizontal scroll, text-layer survival, fit restore, device-pixel rendering) and workspace image zoom (intrinsic sizing, fixed 200%/100% scale, scrollport overflow).

## Verification

`zoom-viewport`, `pdf-body`, `workspace-preview`, and `workspace-reload` client specs cover the store, controls, redraw, dispatch, and reload fences; `workspace-office` and `workspace-files` e2e exercise the real composition. Typecheck, oxlint, translation pairing, and `git diff --check` pass on the change.
