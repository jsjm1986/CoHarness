# Agent Note: Flow-gated chat follow layout effect

Status: implemented

English | [中文](2026-08-24-chat-follow-effect-dependencies.zh.md)

## Problem

The Chat view's layout effect performs open restoration, prepend anchoring, and bottom-follow decisions. Running it after every render makes unrelated chrome state and reader-position updates revisit that layout work while a long transcript is mounted.

## Decision

The layout effect runs when its flow inputs change: the open state, first and last node identities, the last node kind, the pending steering identity, the flow signature, or the scroll-memory callbacks. Size-only changes remain owned by the existing `ResizeObserver`, and the scroll listener continues to update reader position independently. The effect still handles initial restoration, prepend anchoring, trailing user/steering delivery, and pinned flow growth; no Chat nodes are removed or virtualized by this change.

## Alternatives considered

**Keep an every-render layout effect.** Rejected because scroll-position state and unrelated overlays can trigger the same geometry work without changing the flow inputs.

**Introduce Chat virtualization in this change.** Rejected because variable Markdown, tool, image, streaming, inspect, and prepend geometry require a separate experiment and broader browser contract.

**Move follow decisions into scroll and stream event handlers only.** Rejected because initial mount, tab restoration, and React-owned prepend commits still need a post-commit layout phase.

## Consequences

Unrelated Chat renders do not re-run the flow layout decision, while the existing scroll, prepend, streaming, and tab-restoration behavior remains covered by ChatView unit tests, scroll-contract and continuous-conversation browser tests, and the high-cardinality performance suite. Resize-driven bottom-follow and the semantic anchor model remain unchanged. A future Chat virtualizer must preserve this separation rather than fold size observation into the flow effect.
