# Agent Note: Complete reasoning Markdown in the Web disclosure

Status: implemented

English | [中文](2026-09-22-complete-reasoning-markdown.zh.md)

## Problem

The reasoning disclosure truncated a streaming body to its final 16 KiB even after the reader expanded it. Its durable text was complete, but the visible reading surface lost earlier content and rendered Markdown as literal prose.

## Decision

Adopt the alpha.2 upstream compact Markdown presentation in the existing [conversation](../../../../packages/client/ui-conversation/README.md) disclosure and [Markdown renderer](../../../../packages/client/ui-primitives/README.md). Expansion renders the complete source through the existing incremental parser. Completed blocks retain their cached elements; the body is not replaced with a suffix. The collapse control stays sticky, while compact code banners remain in flow.

Keep the [local summary follower](2026-08-02-web-thinking-tail-scroll.md): live summaries follow the latest non-blank line using the existing throttled scroll update, and settled summaries skip leading formatting whitespace. Summary emphasis markers are omitted. Expansion and collapse do not edit durable text, move the conversation scroll position, or change model input.

## Alternatives considered

**Keep a bounded expanded suffix to limit rendering work.** This hides content precisely when the reader asks to inspect it. Incremental parsing reduces repeated work while preserving the complete body.

**Replace the local streaming follower with an independent animation.** Movement must follow arriving content and stop when generation pauses. The existing throttled update already provides that behavior.

## Consequences

Expanded reasoning uses Markdown semantics, so formatting whitespace is interpreted rather than displayed verbatim; fenced code retains its indentation. The same sanitization and safe-link rules apply to body and compact variants. Collapsed reasoning does not mount the Markdown body. Long expanded content remains a reading surface and never auto-scrolls the reader away.

Regression tests retain the first decision, all 900 paragraphs and newly appended text beyond 16 KiB, check semantic emphasis and safe links, and preserve the summary follower and settlement reset. Code-banner DOM fixtures change only by the explicit styling attribute.
