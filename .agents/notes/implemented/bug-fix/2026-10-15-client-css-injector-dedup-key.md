# Agent Note: Client CSS injector dedup keys carry the src-relative path

Status: implemented

English | [中文](2026-10-15-client-css-injector-dedup-key.zh.md)

## Problem

`styleInjectionModule` in `packages/client/tsdown.client.ts` deduped each emitted `<style>` tag by `${packageId}/${basename(file)}`. Two stylesheets with the same basename in different directories of one package therefore shared a dedup key: whichever module evaluated first injected its rules, and the second file's rules were silently dropped — its class names still applied, so elements rendered with user-agent defaults. `ui-tool` carried the collision: `tool/ToolDetails.module.css` lost to `tool/components/ToolDetails.module.css`, leaving `.code` output `<pre>` elements unwrapped (`white-space: pre`, no padding) and pushing the right-sidebar details panel past 750px wide on a 390px viewport.

LightningCSS also derives CSS Modules scopes from its filename input. Absolute checkout paths make identical source trees emit different class names and invalidate otherwise unchanged lazy bundles across release directories. Three inspected releases have identical PDF stylesheet source but differ by 37 scope-prefix substitutions in their 2,222,385-byte PDF chunks.

## Decision

The shared stylesheet identity is `${packageId}/${path after the last /src/ marker}`, with forward-slash separators and a basename fallback outside `src/`. It supplies both the dedup key and LightningCSS filename. Physical paths remain the source of file reads, virtual module ids, and watch dependencies. Package scopes and same-named source directories stay distinct; equivalent private checkout roots emit identical class maps and injectors.

## Alternatives considered

**Rename one of the colliding files.** Fixes this instance but leaves the silent-drop mechanism armed for the next same-named pair; the bundler owns the key, so the bundler is the fix site.

**Skip dedup and always inject.** Duplicate injections of shared module styles would restamp identical rules on every importer; the check exists to prevent that, only its key was too weak.

**Use only the relative filename for CSS Modules.** This removes checkout dependence but lets different packages assign the same scope to matching source paths. The package-scoped identity preserves isolation without machine-specific input.

## Consequences

Both `ui-tool` details stylesheets inject, and long tool output wraps inside the details panel. Unchanged source no longer acquires a different CSS scope solely because of the release directory. Class names and diagnostic tag ids are build artifacts; source edits still change emitted styles. This does not make lazy resource URLs independent of their owning package revision.

## Verification

`scripts/client-bundle-css.spec.ts` exercises the actual compiler plugin: equivalent source paths in independent roots emit identical modules, package and source-directory scopes differ, edits change output, and physical watch dependencies remain intact. Against the absolute-filename implementation, the cross-root equality and package-isolation cases fail; the remaining five cases pass. Browser timing and total Word conversion latency are separate measurements.
