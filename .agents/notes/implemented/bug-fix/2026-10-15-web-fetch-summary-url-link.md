# Agent Note: Collapsed web_fetch row links its URL

Status: implemented

English | [中文](2026-10-15-web-fetch-summary-url-link.zh.md)

## Problem

A collapsed `web_fetch` row printed the request URL as plain summary text, so opening the fetched page meant expanding the row first to reach the card's link. The upstream fix is `61a0ed487eb`.

## Decision

`webFetchHref` derives the link target from the call's parsed arguments and returns it only for `web_fetch` calls whose `url` parses with an `http:` or `https:` protocol; every other tool, protocol, or unparsable argument stays plain text. `WebRow` passes the result to `ToolRow`'s new `href` prop, which renders the summary as an anchor that opens in a new tab (`rel="noopener noreferrer"`) and stops click and Enter/Space propagation so the link never toggles row expansion. An error or stopped row suppresses the link — its summary is error prose, not the URL. The file-path button keeps its own Host-opener path and is unaffected.

## Alternatives considered

**Link the summary for every tool whose args contain a URL.** Only `web_fetch` has a call contract whose whole summary is the URL; other tools' summaries mix prose and values, so a per-tool derivation stays explicit rather than heuristic.

**Reuse the expanded card's link data.** The card model reads the settled `resultView`; the summary link needs the call argument, which exists while running too, so the helper reads `args` through `parsedToolCall` — the same validator the summary text uses.

## Consequences

Clicking the collapsed URL opens the page in a new tab without expanding the row; clicking elsewhere still expands it. The local `clickable-links-gallery` e2e does not exist, so coverage is the focused `web-card.client.spec.tsx` suite. The security rule — never render a non-http(s) scheme as a link — now lives in one helper shared by every lifecycle state.

## Verification

`web-card.client.spec.tsx` covers `webFetchHref` for http/https acceptance, non-http and unparsable rejection, absent calls, and non-fetch tools, plus the rendered anchor's `href`/`target`/`rel`, click and Enter not expanding the row, and an error row keeping plain text. Full `ui-tool` suite and package typecheck pass.

## Related

- [2026-08-23 Client-derived tool presentation](../architecture/2026-08-23-client-derived-tool-presentation.md) — owns the web card's settled-result model; this link reads call arguments instead.
