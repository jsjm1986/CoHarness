# Agent Note: Load recent conversation history first on remote nodes

Status: implemented

English | [中文](2026-11-21-node-prepared-history-limit.zh.md)

## Problem

A prepared history request moves the first authorized page through the node Gateway before the browser can render a conversation. A default 50-message page can spend more time crossing a WAN link than the reader needs to see the latest exchange.

## Decision

The [owning node](../../../../gateway/README.md) configures the cap on its prepared first page. The [Fetch carrier](../../../../packages/host/apiproxy/README.md) honors a smaller caller limit and delegates the read to the Session owner. The result retains complete append-origin groups and the existing event ranges from [conversation-tier transport](2026-08-18-conversation-history-tier.md).

The [Chat view](../../../../packages/client/ui-conversation/README.md) requests an older page when the reader scrolls up to the loaded head or chooses **Load earlier**. It preserves the visible row during the prepend. A browser position restored after navigation does not issue a paging request.

## Alternatives considered

**Use a smaller limit for every history page.** Readers retrieving a long conversation would pay for many more sequential round trips. A cursor identifies an explicit request for earlier content and keeps the ordinary page budget.

**Start fetching older history after drawing the first page.** An automatic transfer can compete with new conversation and draft requests and pay for data the reader may never inspect.

## Consequences

Trajectory, live history recovery and authorized full-detail reads use their existing page selection. The same Session visibility, Runtime ownership and draft ownership apply to every page.

The [assembled browser scenario](../../../../apps/web/tests/deferred-remote-entry.e2e.ts) verifies an underfilled first page, the older-page control, and draft restoration. The [long-history scenario](../../../../apps/web/tests/lossless-history-wire.e2e.ts) verifies each visible message after pagination and exact reconstruction of the detailed window.
