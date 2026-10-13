# Agent Note: Right-sidebar tab chips own their semantic title presentation

Status: implemented

English | [中文](2026-10-12-sidebar-tab-chips-own-semantic-titles.zh.md)

## Problem

Right-sidebar chips rendered whatever plain string the tab registry captured at open time. For `tool-details` that string was the raw call id (`call-9`); for `workspace-file` the resource's full path; `changes-review` drew no glyph at all — while terminal, browser, schedule, and guide chips already carried live semantic titles with icons. The strip mixed identification styles, and the ids users saw were durable addresses, not labels.

## Decision

Each tab type registers a `sidebar.right.pane.tab.title` renderer that owns its chip's glyph and text; the registry's captured string degrades to the fallback, not the presentation. The generic sidebar shell keeps no per-type knowledge.

- **Tool details resolves the call, not the id.** `toolCallPresentation` walks the owning Session's loaded window — running calls plus the tool-result surface's `subCalls` trees, so a nested `run_code` dispatch resolves too — and returns the wire `name` plus the card kind the details body renders (`resultView.card`, then `callView.card`, `generic` normalized away). The chip pairs that name with the card's intent glyph (terminal prompt, edited file, search, read, web marks; wrench when generic or unresolved), so the icon states what the body is, not a per-tool brand map. A call outside the loaded window — a restored tab, a scrolled-away call — keeps the captured call-id text and the generic glyph.
- **Workspace files show the basename under the file-type glyph.** `WorkspaceFileTitle` classifies the full captured path through `FileTypeIcon` but displays only its basename; a path with no final segment keeps the whole title verbatim.
- **Changes review pairs its file-pen glyph with the localized captured title** (`Turn N review`), which the definition already mints correctly — the gap was glyph, not text.
- **The panel's chrome controls join the strip's circular-icon vocabulary.** `.iconButton` moved from `--dsw-radius-sm` to `--dsw-radius-full`, matching dockkit's strip buttons that sit beside it.

## Alternatives considered

**A generic shell map from tab type to icon.** Dropped: it would invert the registry's ownership — the shell would need every type's semantics while each type already declares its own body and title slots.

**Capturing a better title string at open time.** Dropped: it freezes the running state — a settling call's card kind can change (generic call intent → terminal result), and the captured string is static. The renderer resolves at read time and stays live within the window.

**Reusing ui-tool's per-tool-name icon map.** Dropped: that map brands tools by name for conversation rows; the chip's job is to name the card the details body renders, which is exactly what the tool's declared render intent already encodes.

## Consequences

Chips repaint only on member-wise change (`shallowEqual` on `{name, card}`), so a settling call does not churn the strip. Future card kinds extend the glyph switch without touching the shell; a call id remains reachable in the chip only for out-of-window tabs. The `sidebar.right.pane.tab.title` seat is now the complete contract a new tab type implements: register it and the chip is semantic by construction.
