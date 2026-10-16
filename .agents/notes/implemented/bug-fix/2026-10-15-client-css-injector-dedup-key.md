# Agent Note: Client CSS injector dedup keys carry the src-relative path

Status: implemented

English | [中文](2026-10-15-client-css-injector-dedup-key.zh.md)

## Problem

`styleInjectionModule` in `packages/client/tsdown.client.ts` deduped each emitted `<style>` tag by `${packageId}/${basename(file)}`. Two stylesheets with the same basename in different directories of one package therefore shared a dedup key: whichever module evaluated first injected its rules, and the second file's rules were silently dropped — its class names still applied, so elements rendered with user-agent defaults. `ui-tool` carried the collision: `tool/ToolDetails.module.css` lost to `tool/components/ToolDetails.module.css`, leaving `.code` output `<pre>` elements unwrapped (`white-space: pre`, no padding) and pushing the right-sidebar details panel past 750px wide on a 390px viewport.

## Decision

The dedup key is now `${packageId}/${path after the last /src/ marker}`, falling back to the basename for files outside `src/`. The key stays package-scoped and deterministic; same-named siblings produce distinct tags while a file bundled into several packages still injects once per package, as before.

## Alternatives considered

**Rename one of the colliding files.** Fixes this instance but leaves the silent-drop mechanism armed for the next same-named pair; the bundler owns the key, so the bundler is the fix site.

**Skip dedup and always inject.** Duplicate injections of shared module styles would restamp identical rules on every importer; the check exists to prevent that, only its key was too weak.

## Consequences

Both `ui-tool` details stylesheets now inject; long tool output wraps inside the details panel instead of widening it. Any future same-basename pair under `src/` is covered without author awareness. Existing tagIds shift for nested files only — they are diagnostic attributes, not a compatibility surface.

## Verification

`scripts/client-bundle-css.spec.ts` gains a case asserting two same-named `Fixture.module.css` files under different `src/` directories emit different tagIds. Runtime probe on the assembled app: `pre.IiKC8q_code` computes `white-space: pre-wrap` with `scrollWidth` equal to its 357px box, and the injected `data-plugin-css` tag list shows both `ui-tool` ToolDetails paths.
