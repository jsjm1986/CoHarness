# Agent Note: Configurable text, code, and terminal fonts

Status: implemented

English | [中文](2026-10-17-configurable-font-settings.zh.md)

## Problem

The theme plugin stored only the palette preference: conversation text, code blocks, and the sidebar terminal rendered at fixed sizes on the built-in family stacks. Upstream made all three roles configurable — integer px sizes inside per-role ranges and comma-separated family lists layered ahead of each built-in stack — with the settings surface, keyboard control, first-paint application, and durable persistence the feature implies.

## Decision

`ThemeSnapshot` carries `fontSizes` and `fontFamilies` beside `preference`, and the `ui-theme` settings section grows one field per role — `fontSize`, `codeFontSize`, `terminalFontSize`, `textFontFamily`, `codeFontFamily`, `terminalFontFamily`. The settings scope remains the single write channel: every accepted value is written through `host.set(field, value)` inside the `pendingWrites` fence, so a Host echo of an earlier write cannot revert a newer optimistic change, and `adopt()` republishes only on a durable difference.

Family input is normalized once at the service boundary: unsafe characters are stripped, non-generic names are quoted, and `''` selects the built-in stack, so every stored list is safe to embed in inline CSS and the boot script. The same normalized list is what the snapshot, the settings row, and the presenter see.

The settings UI is one `settings.general.item` entry: a font-size row for text whose disclosure opens the code and terminal size rows plus one family field per role. The shortcut catalog reserves `fontSize.increase`/`fontSize.decrease` on `primary+=`/`primary+-` (`primary+shift+=` also increases), desktop-only, and adjusts every role inside its own range in one snapshot publication; composition, default-prevented, repeat, terminal-region, and mismatched-modifier input is left unconsumed.

`ThemePresenter` owns the six body variables (`--dsh-content-font-size`, `--dsh-code-font-size`, `--dsh-terminal-font-size`, `--dsh-font-family-{text,code,terminal}`), writing or removing each at the commit point. The Host index bootstrap emits the durable sizes and lists on `body` before the shell mounts, so first paint and `bootstrapFontSizes`/`bootstrapFontFamilies` match what the scope later adopts. The markdown ladder tracks the settings through `--dsh-content-font-delta` and `--dsh-code-font-delta` anchored on this fork's local type scale rather than upstream's absolute values. The sidebar terminal consumes its own role without replacing a live xterm instance, and refits only a visible writable terminal when geometry changes.

**Scope decode resolves the raw account layer.** `account-or-host` binds declare `decode: decodeThemeSection`, which resolves each section through `ThemeSettingsSchema`. The account preference mirror can publish a section that predates the font fields (its `ui-theme` whitelist holds only `preference`), and the composite merge can surface that raw section while the Host layer is still loading; schema resolution fills the absent fields so `getSnapshot().value` keeps the documented "schema-resolved section" contract on both lanes ([field routing](../bug-fix/2026-10-03-account-or-host-field-routing.md)).

## Alternatives considered

**Tolerate missing fields at the consumer.** Reading `section.textFontFamily ?? ''` in `durableFontFamilies` and `sectionFontSizes` duplicates the schema's default table at the read site and leaves every future consumer to rediscover the same gap; resolving at the scope boundary is the contract the scope already documents.

**Complete the section inside `mergeSectionLayer`.** The merge cannot know which fields a complete section needs when the Host layer is absent — it has no schema — so it would either withhold a valid account-only section (`locale` is complete without the Host) or keep leaking partial ones.

**A dedicated font settings namespace.** Splitting the section lets rows write disjoint documents, but the preference and font fields are one user-facing theme choice; one section keeps adoption, revision fencing, and the boot script's durable read atomic.

## Consequences

- `ThemeRuntime` owns `setFontSize`/`setFontFamily` and the all-role `adjustFontSizes`; the fixed catalog actions `fontSize.increase`/`fontSize.decrease` exist only under the desktop shortcut runtime.
- The `ui-theme` section now persists six font fields beside `preference`; documents written before the fields resolve to defaults on read.
- `packages/client/ui-settings` gains no change: the existing `decode` hook is the seam, and this is its first in-tree consumer that relies on schema resolution rather than plain-object acceptance.
- Settings e2e (`settings-chrome`) records the font row in both dialog goldens and proves write, reload persistence, and reset against the real Host document.

## Verification

`packages/client/ui-theme` unit and apply specs cover store sync, per-role writes, pending-write fencing, shortcut matching across platforms, and HMR teardown; `ui-layout` presenter specs cover variable writes and retraction; terminal specs cover family/size consumption and refit gating. The web e2e exercises the real settings document end to end. Typecheck, lint, the unknown-cast gate, and translation pairing pass on the change.
