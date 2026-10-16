# Agent Note: Shared code-card toolbar unifies wrap, copy, and language chrome

Status: implemented

English | [中文](2026-10-15-shared-code-card-toolbar.zh.md)

## Problem

`CodeBlock`, `ReadBlock`, and `DiffBlock` each grew their own header: the fence and read cards carried a language banner with a copy button, while the diff card floated copy in its top-right corner with no language affordance at all. None of them could wrap long lines — a read of a 200-column line and an unwrapped diff both forced horizontal scrolling with no escape, and MarkdownText's compact variant still rendered the full banner. Upstream source: `8d2cd0cf72090cc58fe8cfc9258ebbdf58ac9f1` and its overflow fix `f114233545f131bd8f16ddaa8487f4fe820dc8cd` (both inside alpha.2); the later spacing/material commits `62f816f3a57` and `fdd14a09898` stay outside this change.

## Decision

`ui-primitives` owns a shared code-card chrome. `CodeCard.module.css` holds the card shell, header row, and body rules once, including the compact mobile geometry (44px minimum targets, zero vertical padding, 10px insets below 768px) that previously lived per-card. `CodeToolbar` renders the header for every code-family surface: a title or language label, a wrap toggle, and a copy control. Its `CodeToolbarLabels` contract is carried to Markdown through `MarkdownCodeLabels.toolbarLabels`, and `MarkdownText` strips that member for `variant="compact"`, so compact surfaces (tool rows, plan previews, question composers) keep their owner styling instead of inheriting the full toolbar. A source preview that omits `toolbarLabels` likewise renders no toolbar, letting owner CSS keep control.

Each card decides its own wrap default and wires the toggle to a `data-code-wrap` attribute on the card root. Fenced `CodeBlock`s start wrapped (`pre-wrap`) because Markdown prose wraps; `ReadBlock` and `DiffBlock` start unwrapped (`pre` plus horizontal scroll) so line numbers and diff columns stay aligned, and the toggle switches them to `pre-wrap` per mounted card — wrap state is local `useState`, never lifted, so two cards in one turn wrap independently. The wrap button keeps a stable accessible name (`codeBlock.wrap`, "Wrap lines") across states with `aria-pressed` carrying the state, while its tooltip names the next action (`codeBlock.unwrap`/`codeBlock.wrap`); the icon swaps between `IconNowrapFill16` and `IconWrapFill16` to show the current mode. A missing or unknown language resolves to the localized `codeBlock.title` fallback ("Code block"), and a diff whose paths disagree in language takes the same fallback rather than picking one file's grammar. Copy always writes the original text — never the wrapped rendering, the gutter numbers, or the toolbar — and hides when the card has no copyable content.

Two overflow mechanics ride along with the unification. `ReadBlock` sizes its gutter from the largest returned line number (`--dsl-read-gutter` in `ch`, minimum 3 digits), so a read window at offset 99,999 keeps its gutter inside the card instead of overlapping content. `DiffBlock` lays its body out as a grid whose unwrapped column is `minmax(max-content, 1fr)` and wrapped column `minmax(0, 1fr)`, so an added or removed row's background fill extends across the whole horizontally scrollable width instead of stopping at the viewport edge; wrapped rows use `overflow-wrap: anywhere` so a single long token can still break. Both row fills use the new static alpha tokens in `ui-theme` (`--dsh-diff-add-fill`/`--dsh-diff-remove-fill` aliases over theme-independent alpha colors), because a diff row must keep its fill under both syntax themes and inside scrollable overflow where theme-relative backgrounds broke.

## Alternatives considered

**Per-card toolbars.** Rejected: three cards sharing one toolbar contract keeps the labels, tooltips, icon targets, and mobile density identical; per-card headers already drifted (the diff card lacked a language label entirely).

**Session- or conversation-level wrap preference.** Rejected: a global toggle would surprise the reader who wraps one long read but wants the next diff's columns intact; per-card state matches the upstream behavior and costs one `useState` per card.

**Toggle wrap by swapping the accessible name.** Rejected for assistive technology: a control whose name changes between "Wrap lines" and "Do not wrap lines" reads as a different button each press, so the name stays fixed and `aria-pressed` plus the tooltip carry the state.

**Keep the compact variant's banner.** Rejected: compact Markdown renders in space-constrained seats where a full header row is visual noise; stripping `toolbarLabels` in `MarkdownText` is the single gate, so every compact consumer gets the omission for free.

## Consequences

Every code-family card in conversation, tool details, preset guides, plan previews, and question composers presents the same header: language label, wrap, copy. Unwrapped surfaces keep `pre` scrolling until the reader opts into `pre-wrap`; the copied text is identical either way. Owner-styled previews that pass no `toolbarLabels` — including `MarkdownText` compact — render without the toolbar, so the change cannot regress seats that style their own chrome. The diff card's grid body makes long-row fills span the scrollable width and keeps wrapped diffs inside the viewport. Cards that render no copyable content expose no copy control. The labels live in the `common` locale namespace (`codeBlock.title`/`.wrap`/`.unwrap`), so any `TranslateNS` consumer resolves them without per-package keys.

## Verification

`packages/client/ui-primitives/tests/code-card-controls.client.spec.tsx` pins the shared chrome across `CodeBlock`, `ReadBlock`, and `DiffBlock`: initial `aria-pressed` state per card family, toggle flipping it while the accessible name stays "Wrap lines", the tooltip naming the next action, copy receiving the unwrapped original text, the language fallback title, the mixed-language diff fallback, and the `toolbarLabels`-less render exposing no toolbar. `diff-card.client.spec.tsx` covers the grid wrap attributes. `apps/web/tests/code-card-layout.e2e.ts` drives a seeded session (read offsets 999 and 99,999 plus a long-line edit) asserting gutter digits stay inside the gutter, wrapped/unwrapped source alignment, wrapped diffs fitting the viewport while unwrapped overflow, full-scrollable-width light/dark row fills, inset markers, and a clean console. `navigation-panes.e2e.ts` covers the live fenced block: copy and wrap tooltips, `white-space` flipping between `pre` and `pre-wrap`, and unchanged source text, with the card snapshot in the `code-card.expected.md` golden. The `ui-primitives` suite, affected `ui-tool`/`ui-conversation` suites, client build, and translation pairing pass.

## Related

- [2026-07-30 Web diff card](2026-07-30-web-diff-card.md) — owns diff grouping, footer, and the `pre` divergence; this note owns the shared chrome the card now mounts.
- [2026-07-30 Web read card frontend](2026-07-30-web-read-card-frontend.md) — owns the read model and lazy grammars; the toolbar title reads the same `title`/path its model produces.
- [2026-08-26 Compact mobile code and result cards](2026-08-26-mobile-code-card-density.md) — owns the phone-density decision; the shared card stylesheet now hosts those rules for toolbar cards.
