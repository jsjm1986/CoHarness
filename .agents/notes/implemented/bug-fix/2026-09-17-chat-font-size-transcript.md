# Agent Note: Chat font-size preference reaches transcript text

Status: implemented

English | [中文](2026-09-17-chat-font-size-transcript.zh.md)

## Problem

The transcript text-size preference changed `--dsh-chat-font-size` on the pane root but assistant markdown body text never resized: `MarkdownText`'s `.markdown` container pins `font: var(--dsw-font-markdown-base)` (16px/28px), severing the inheritance between the pane variable and the paragraphs users read. Plain-text surfaces (user bubble, chat chrome) already consumed the variable, so the slider visibly moved while the dominant reading surface stayed fixed.

## Decision

The pane root re-points the three body-size markdown tokens — `--dsw-font-markdown-base`, `--dsw-font-markdown-base-strong`, and `--dsw-font-markdown-h4` — at the preference via a delta calc: preference 14 maps to the designed 16px/28px baseline, and every step above or below scales the reading text at the tokens' 1.75 line-height ratio. Heading h1–h3, code, and table tokens keep their design sizes; the compact viewport's mobile-body token override is untouched.

## Alternatives considered

**Map the preference to the markdown size absolutely.** Rejected: the preference default (14) would shrink the designed 16px body to 14px out of the box, and the 12–17 range would render the reading surface below the design baseline at every ordinary setting.

**Teach `ui-primitives` MarkdownText a chat variable.** Rejected: the shared sheet must not depend on a conversation-domain variable; re-pointing the design tokens on the consuming pane keeps primitives generic.

## Consequences

The font-size preference now resizes the transcript's markdown body, strong text, and h4 headings in single-session and workbench panes alike. Content-width and fill preferences were already effective and are unchanged. At the default preference the rendered markdown matches the previous fixed size exactly.

## Testing

The [display-settings spec](../../../../packages/client/ui-conversation/tests/display-settings.client.spec.ts) asserts the token re-point in the pane stylesheet, and the fix was verified live against a real server session: markdown paragraph text computes 16px at the default preference, 14px at 12, and 19px at 17. Gaps: no automated renderer test measures computed pixel sizes; h1–h3 headings and table/code density intentionally remain fixed, so documents dominated by those elements resize less visibly.
