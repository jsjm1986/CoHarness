# Agent Note: Same-origin native document PDF framing

Status: implemented

English | [中文](2026-10-23-native-document-pdf-framing.zh.md)

## Problem

The document library embeds authenticated PDF content in an iframe. A response forbidding every frame ancestor rejects that intended preview before the native PDF reader loads. The same document routes also serve active HTML and SVG content, so granting framing to every inline response would expand the privileges of unrelated formats.

## Decision

Only an inline response whose server-declared media type is exactly `application/pdf` admits same-origin ancestors. The [document HTTP reference](../../../../packages/host/userdoc-http/README.md#known-limitations-and-deferred-work) owns the response rules. Both the Host handler and Gateway runtime forwarder apply them; the [local broker](../architecture/2026-10-15-gateway-local-document-broker.md) uses the same Host handler. This changes response framing without changing byte streaming, account/runtime identity checks, membership authority, or the UI's authenticated content URL.

The CSP `sandbox` directive stays bare. Chromium's [native PDF tests](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/pdf/pdf_extension_test.cc#506) distinguish native PDF handling under that response directive from iframe embedding blocked by `frame-ancestors`. This is not permission to add `allow-scripts`, `allow-same-origin`, or any iframe sandbox exemption. HTML, SVG, text, and unknown types retain their current treatment.

The store derives media types from names rather than validating document structure. `nosniff`, the declared PDF response type, and the native reader's PDF parser therefore matter together: a renamed HTML file reaches the PDF reader's failure state rather than the application's HTML DOM. Chromium's [security guidance](https://chromium.googlesource.com/chromium/src/+/main/content/SECURITY.md#mitigating-factors) separately describes PDF renderer isolation; a response CSP sandbox is not the browser process sandbox.

The dialog allocates height through minimum and maximum constraints, so a percentage minimum height does not reliably replace an iframe's intrinsic height. The PDF iframe grows and shrinks as a flex child within the available body, independently of content-sized text and image previews. The [UI reference](../../../../packages/client/ui-documents/README.md#usage) owns the preview sizing behavior.

## Alternatives considered

**Remove the response CSP or relax every inline type.** This grants unrelated uploaded markup permissions that the native PDF path does not require.

**Remove CSP sandbox for PDF preemptively.** Native Chromium acceptance succeeds with the existing directive. Removing an additional restriction without a demonstrated compatibility failure is unnecessary.

**Read the whole document into a Blob or import another UI plugin's renderer.** Either introduces document buffering or a new cross-plugin runtime dependency to repair a response-policy mismatch. The current authenticated streaming URL already supplies native PDF content.

## Verification

The [runnable fixture](../../../../packages/host/userdoc-http/tests/native-preview-fixture.ts) creates only synthetic documents under a temporary root and mounts the production Connection, filesystem store, and document HTTP owner on a random loopback port. An independent port serves a different-origin parent. Native Chrome displays the valid PDF, refuses that different-origin embed through `frame-ancestors 'self'`, rejects a renamed HTML file as invalid PDF, and keeps HTML/SVG frames blocked with the script-execution sentinel unchanged.

The assembled Host snapshot pins PDF, renamed PDF, HTML, SVG, text, HEAD, unauthenticated access, complete streaming bytes, and attachment downloads. The Gateway forwarding matrix retains its lease through stream completion and checks unsupported MIME values. Local-broker tests additionally request the same document id from another account and receive no document bytes; missing collaboration and non-member project checks reject before reads.

The [assembled document manager](../../../../apps/web/tests/document-manager.e2e.ts) saves a self-authored PDF in its isolated real store and measures iframe and available-body rectangles at desktop and 390px widths. Close and Escape remove the iframe and its browser frame while preserving the manager.

## Consequences

The library's intended native PDF iframe can load from its own origin while unrelated uploaded formats keep their existing restrictions. Direct downloads stay attachments and no page-level document cache is introduced. Browsers retain their native PDF capabilities and error handling; embedded PDF support remains browser behavior rather than a new application renderer.
