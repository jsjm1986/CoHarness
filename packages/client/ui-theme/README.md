---
description: "Theme, font-size, and font-family settings for the dsh web client: Host bootstrap for the pre-plugin palette and typography; DOM-free ThemeRuntime state; --dsw-* token styles; Appearance and font settings rows"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

English | [中文](README.zh.md)

Theme plugin: ThemeRuntime over the --dsw-* token base stylesheets (static scale + alias semantic layers). The service owns the live theme preference (`light`/`dark`/`system`), the text/code/terminal font sizes, and the three font-family lists, resolves `system` through `prefers-color-scheme`, and publishes immutable `ThemeSnapshot`s on the `theme/change` event; it never touches the DOM — ui-layout's presenter applies the resolved snapshot (`html { color-scheme }`, `body[data-ds-dark-theme]`, inline alias tokens, and the `--dsh-*-font-size` / `--dsh-font-family-*` variables). A loopback browser provides the service immediately with the schema defaults, then loads the `ui-theme` namespace in the background and writes each accepted change through the Host settings API, whose local provider stores it in `$DSH_HOME/settings.yaml` by default; pushed settings changes and reconnects refetch it, rapid selections are serialized in gesture order with namespace revisions, and a rejected latest write reloads the durable section. While its own writes are pending, the service ignores refetched sections, so an echo of an earlier write cannot revert a later change; it adopts the durable section once the writes settle. A public page behind a gateway that rewrites `Host` to the instance loopback writes the same Host setting; a request that fails the privileged-method fence stays at the in-memory default. Third-party registered theme ids remain an in-process extension and do not cross the built-in settings schema; removing one never overwrites the last durable built-in preference. The [Host-backed preferences decision](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) owns the persistence boundary.

Users switch the color scheme, font sizes, and fonts from rows in Settings (General section); the choices persist across restarts on a loopback browser. The plugin registers Appearance preference cubes and the text font-size stepper in the General section; a More font settings button after the stepper expands a region, collapsed on every settings open, with a font-family row for each of text, code, and the terminal plus the code and terminal font-size steppers. The text stepper accepts integer values from 10 through 22 px and defaults to 14 px; the code stepper takes 10–16 px (default 11) and sets the code-block size while inline code stays 1 px larger; the terminal stepper takes 10–20 px (default 13) and sets the sidebar terminal cell font size. Each font field takes comma-separated family names and commits on blur or Enter; an empty field restores the built-in stack. The service normalizes each list by dropping quotes, backslashes, angle brackets, and control characters and double-quoting every name except CSS generic families, then stores it in `textFontFamily`, `codeFontFamily`, or `terminalFontFamily`. The user list precedes the role's built-in stack, so a font missing on the machine falls back to the default; the field accepts any installed font name and does not enumerate local fonts. On desktop runtimes, the fixed shortcuts Primary+= / Primary+Shift+= and Primary+- step all three font sizes together inside their own ranges.

When the host composition includes an HTTP server, the host half injects a synchronous bootstrap immediately after the opening `<body>` tag. Each index response embeds the registered `ui-theme` settings, or the schema defaults when no settings provider is present; the browser resolves `system` from the OS scheme, then sets `color-scheme` and `body[data-ds-dark-theme]` before the shell loading page renders. The same body script seeds `--dsh-content-font-size`, `--dsh-code-font-size`, `--dsh-terminal-font-size`, and each non-empty `--dsh-font-family-<role>` list, so the first paint uses the saved typography and `ThemeRuntime` starts from it instead of rendering the defaults first. Compositions without an HTTP server remain unaffected, and ThemeRuntime and ui-layout remain authoritative for client state and subsequent DOM updates after the plugin tree activates.

`src/styles/` holds seven sheets imported in order by ui-theme's dynamic client entry: `base.css`, `corner-shape.css`, `design-platform.css`, `metrics.css`, `scrollbar.css`, `gradient-shadow-text.css`, and `shiki.css`. `base.css` also owns the font tokens: `--dsh-font-family-text-default` and `--dsh-font-family-code-default` hold the built-in stacks on `:root`; on `body`, `--dsw-font-family` and `--ds-font-family-code` place `--dsh-font-family-text` and `--dsh-font-family-code` ahead of those stacks, and an unset list resolves to the built-in stack (repeated once, which font matching ignores). The client bundle compiles and injects them as plugin-owned global styles, so unload and HMR remove them with ui-theme instead of leaving theme CSS in the static web shell. `metrics.css` supplies the shared spacing, safe-area, radius, touch-target, phone-sheet geometry, compact typography/icon roles, and stateful-control geometry used by client packages. Stateful mobile controls must keep readable current-value text and use the shared settings-sheet grammar rather than feature-local picker chrome. `scrollbar.css` is the sole consumer of the `--dsw-alias-scrollbar-*` tokens and must follow `design-platform.css`, which declares them. `design-platform.css` also owns the code-diff fill aliases and their static alpha palette entries; `shiki.css` owns syntax colors.

Scrollbar rebinding contract: `scrollbar.css` binds `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` on `body` to the l1 (base-surface) tokens, and both rendering paths read that pair. An elevated surface (menu, popover, dialog) sets `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` and `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)` on its own container; one rebind retints whichever path the engine took. The pair's other legal target is `transparent`, which draws no thumb at all — [ui-sidebar](../ui-sidebar/README.md) rebinds its column that way while the pointer is elsewhere. A rebind to the l1 pair is not a rebind; it restates the base-surface default. WebKit-based browsers use a 5px default `--dsh-scrollbar-width` and also read `--dsh-scrollbar-thumb-border` and `--dsh-scrollbar-track-margin`; a scroll surface may rebind them to keep a wide draggable rail around a narrower visible thumb or to inset the track from rounded ends — [ui-conversation](../ui-conversation/README.md) reads the width for the overlay composer seat's `right` offset, and card-internal scrollers rebind `thumb-border` so a narrow bar keeps a visible coloured interior. The scrollbar-styles spec pairs these values with their consumers.

The two paths are mutually exclusive by construction. `scrollbar-width`/`scrollbar-color` sit inside `@supports not selector(::-webkit-scrollbar)` because a non-`auto` value of either makes Chromium and Safari discard every `::-webkit-scrollbar*` rule for that element, `::-webkit-scrollbar-thumb:hover` included — declaring both unconditionally leaves `--dsh-scrollbar-thumb-hover` with no rendering anywhere. Firefox therefore takes the standard properties and WebKit-based engines take the pseudo-elements, so the hover token only ever renders through the pseudo-element path. Reasoning and the measured computed values: [the scrollbar Agent Note](../../../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md).

`corner-shape.css` smooths every rounded corner: inside `@supports (corner-shape: superellipse(1.5))` it defines `--dsw-corner-shape` and applies it to all elements and their `::before`/`::after` through the universal selector, so engines without `corner-shape` keep circular corners. Full-round shapes — `border-radius: 50%` circles and pill radii — pair `corner-shape: round` with their radius in the owning component sheet because a superellipse deforms them; the corner-shape stylesheet spec enforces that pairing across every package stylesheet ([corner-smoothing note](../../../.agents/notes/implemented/feature/2026-09-01-web-superellipse-corner-smoothing.md)).

`gradient-shadow-text.css` derives `--dsh-content-font-delta` from `--dsh-content-font-size` and shifts the Markdown heading and base-text ladder by that increment, plus the secondary tier `--dsh-content-font-size-secondary` for table variants and flow rows one step under the body; the code variants (`--dsw-font-markdown-code`, `-code-block`, `-code-block-small`) shift size and line height by `--dsh-code-font-delta`, the difference between `--dsh-code-font-size` and 11 px. It also owns the shadow scale (`--dsw-shadow-lv*`) and the elevation tokens: `--dsw-elevation-stroke` draws a 0.5px hairline through the rebindable `--dsw-elevation-stroke-color`, and `--dsw-elevation-panel`/`--dsw-elevation-prominent`/`--dsw-elevation-soft` (the composer's larger-blur, lower-alpha tier) layer two faint soft shadows over that stroke, so elevated surfaces set `border: 0` and carry no layout-consuming outline; the derived tokens are re-declared per element so a surface's stroke-color rebind takes effect. Flat widgets keep real borders at the `0.5px solid` hairline weight, and the elevation stylesheet spec scans every package stylesheet for both rules ([elevation note](../../../.agents/notes/implemented/feature/2026-09-01-web-elevation-stroke-shadows.md)).

## Summary

`dsh-client-ui-theme` lets Web GUI users choose `light`, `dark`, or `system`, and set the font and font size of text, code, and the terminal separately in Settings. A loopback client stores these values in the `ui-theme` settings namespace, which the local provider persists in `$DSH_HOME/settings.yaml` by default. The plugin resolves `system` through `prefers-color-scheme` and publishes immutable `ThemeSnapshot`s; ui-layout applies each snapshot to the document. The package also ships the `--dsw-*` token stylesheets and injects a synchronous bootstrap so the selected palette, font size, and fonts apply before the shell loads. Third-party themes can register alias-token overrides through `ctx.theme`.

## Table of Contents

- [Settings authority and compatibility](#settings-authority-and-compatibility)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="settings-authority-and-compatibility"></a>
## Settings authority and compatibility

Appearance controls render the account preference while a project policy may force the active light or dark scheme. The account-backed scope disables selection when it reports `loading`, `writable: false`, or a `saving` write; project and provider restrictions are shown inline, and the service refuses a direct `setTheme` call until a writable account view exists. Font-size and font-family writes go through the same bound scope: when the scope is read-only the rows stay interactive but writes are refused and the service keeps showing the durable values. The theme listener supports both `addEventListener` and legacy `addListener` MediaQueryList implementations. The design stylesheet supplies a `100vh` viewport fallback and the client visual-viewport measurement overrides it when available; all `--ds-*` and `--dsw-*` references are checked against CSS declarations by the token-contract test, with runtime-owned viewport height as the explicit exception.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The token sheets are the sole color authority** — values absent from cssdesign (for example the design's #4176E6 tab blue) are deliberately not appended; the nearest semantic token wins. Design-owner-approved additions are the exception and enter as a static step plus a semantic alias in the same change (`--dsw-static-blue-900` / `--dsw-alias-label-primary-bluish`).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
