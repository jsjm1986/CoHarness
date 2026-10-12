# Agent Note: admin-ui dedupes every React-bound package the shared primitives import

Status: implemented

English | [中文](2026-10-12-admin-ui-dedupes-react-bound-primitive-deps.zh.md)

## Problem

`gateway/admin-ui` is a standalone npm project that aliases `@deepseek-ai/dsh-client-ui-primitives` to local source, which re-exports the real workspace icons module. When the shared icon table moved to `lucide-react` imports, Vite resolved that specifier through the root pnpm store while the admin app's own `lucide-react@1.31` came from its own npm tree. Two lucide copies meant two React instances: every icon render called into the wrong React context and the entire admin test suite failed with `Cannot read properties of null (reading 'useContext')`. The failure only surfaced on this branch's CI because master skips the admin-ui job.

## Decision

`resolve.dedupe` in `gateway/admin-ui/vite.config.ts` now lists `lucide-react` alongside `react` and `react-dom`, and the admin `package.json` range moved to `^1.55.0` so the declared tree actually carries every glyph the shared table names.

This is the standing rule for the admin app: any React-bound package imported by the shared primitives it aliases — hooks carriers, context providers, component kits — must be deduped here and kept inside a range the real call sites satisfy. A bare import that works in the workspace breaks silently in the admin app the moment a second copy exists.

## Alternatives considered

**Alias `lucide-react` to a single store path.** Pinning one filesystem copy in `resolve.alias` works until the store layout changes; `dedupe` expresses the intent — one module instance — and survives dependency moves.

**Vendor the icon glyphs into the admin app.** The alias exists precisely to reuse the shared primitives; duplicating their icon set reopens the divergence the shared table closed.

## Consequences

The admin suite renders shared icons against one React context again. The same dedupe-and-range treatment applies to any future React-bound import the shared primitives adopt; a `useContext` null crash in admin tests is the tell.

## Verification

`npm test --prefix gateway/admin-ui` — 32 files, 408 tests — passes with the shared icon table resolved to the admin app's single lucide copy.

## Related

[Shared motion scale and literal-glyph grammar](../feature/2026-10-12-shared-motion-scale-and-literal-glyph-grammar.md) introduced the lucide import this topology now carries.
