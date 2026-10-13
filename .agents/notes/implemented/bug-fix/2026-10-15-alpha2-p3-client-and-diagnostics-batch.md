# Agent Note: Close the alpha.2 P3 residual list — rings, Menu, ContextMeter, persistence, diagnostics

Status: implemented

English | [中文](2026-10-15-alpha2-p3-client-and-diagnostics-batch.zh.md)

## Problem

The alpha.2 audit's P3 paragraph named a dozen visual, performance, and copy residuals: focus rings still painted with `brand-primary` or flat 2px outlines instead of the shared token chain; programmatic Menu refocus drew a ring after every selection; `.titleRow` never declared `container-type`, so every `@container` collapse rule on header occupants was dead CSS; `selectModel` awaited a settings write before acknowledging the session change; spill-write failures blamed a temp-file cleaner on every error code; and zh settings copy mixed English `Subagent` against the product's `子智能体`.

## Decision

One batch closes the whole list against upstream source, keeping intentional divergences.

**Focus rings** on fifteen module surfaces now use `var(--dsw-focus-ring-width)` over `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`; Switch track and check fill follow the same business-state token, and the Browser address-bar ring uses it directly (the odd `brand-primary-new-colorprimary-new-color` alias exists upstream too and stays for its request-boundary use, not for rings). `brand-primary` is a near-neutral button-fill token in both trees, so its previous ring reads were color bugs, not brand styling.

**Menu** distinguishes navigation refocus from post-selection refocus: `focusWithoutRing` suppresses the ring unless the click came through keyboard traversal (`selectingWithTab`). A list-level `collapseSubmenuFrom` closes an open submenu when pointer or focus reaches a top-level plain row and ignores descendants of nested menus; submenu rows open on focus and render their shortcut plus `aria-keyshortcuts`. CSS suppresses duplicate and leading separators.

**`.titleRow`** declares `container-type: inline-size` and the preset label gains the upstream `@container (max-width: 540px)` collapse — anonymous containment is safe because the row is a stretch item of the column header.

**ContextMeter** shows the occupancy percentage in its trigger and anchors its panel through a portal with measured, viewport-clamped placement and outside-pointer dismissal; the local mobile sheet variant stays.

**Model selection** commits the session change synchronously while the deployment default saves in the background; `saveSelection` serializes writes in submission order and a failed save rejects only its own caller, so a slow or failing settings provider can no longer block or undo a session-local choice.

**Spill diagnostics** name the removed directory only on `ENOENT`; other codes (EACCES, ENOSPC, ...) no longer carry the temp-cleaner hint.

**Terminology**: every zh `Subagent`/`子代理` string in ui-settings-plugins, ui-subagent, and ui-agent-preset now reads `子智能体`, matching the product vocabulary the upstream zh files already use; the plan chip moves from warn to business-state tokens; the anthropic provider card gains its own `customAnthropicBaseUrlPlaceholder`. `TOKENIZE_MAX_LINE_LENGTH` (1000 UTF-16 units) now caps all three highlighter entry points.

## Alternatives considered

**Reordering the yml or racing `reflect.get` for late services.** Already proven wrong for the link-opening row earlier in this campaign — concurrent `Promise.all` entry creation makes apply-time probes unreliable; `ctx.inject` is the correct seam and stayed untouched here.

**Blanket `brand-primary` → `state-business-primary` replacement.** Rejected: `brand-primary` keeps legitimate non-focus uses (button fills, request boundaries), so each occurrence was classified against its upstream counterpart before touching it.

## Consequences

Rings render in the accent color across sidebar, header, cards, and controls; Menu keyboard behavior matches upstream submenu and refocus semantics; the header actually adapts under 540px; ContextMeter reads and places like upstream; model switching never blocks on settings I/O; spill failures diagnose the real cause; and zh copy is consistent. Upstream's `attachment`/`file` source-block pipeline (attachment disclosure in trajectory source blocks) remains an adjacent gap under `7520fe94e14`, recorded in the audit, because it needs the data fields, not just the CSS.

## Verification

`ui-conversation`/`ui-primitives`/`ui-subagent`/`ui-settings-plugins`/`ui-settings-models`/`ui-agent-preset`/`ui-trajectory`/`ui-plan`/`ui-collaboration`/`ui-deliverables` specs: 155 files, 2702 tests. `agent-default-model`/`apiproxy`/`subprocess-local` suites: 1191 tests (the `logSpillFailure` spec now pins both error codes). `tsc -b` host and client faces clean; translation pairing re-recorded for the two touched README pairs; lint staged hooks pass.

## Related

- `../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md` — the campaign audit this batch closes out.
- `2026-10-13-clickable-link-language.md` — the sibling client-lane batch that introduced `focusWithoutRing` consumers.
