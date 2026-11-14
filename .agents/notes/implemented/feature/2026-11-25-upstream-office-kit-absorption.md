# Agent Note: Upstream office-kit absorption replacing office-to-pdf

English | [中文](2026-11-25-upstream-office-kit-absorption.zh.md)

Status: implemented

## Decision

Absorb upstream `packages/document/office-kit` (dsh-v0.2.2-rc.3) as the `ctx.officeKit` Host service, replacing `office-to-pdf`, and rewire every consumer. libreoffice-kit moves to `0.2.3`.

## Port adaptations

- **`render`/`generation` Remote endpoints removed** — they resolve Session files through upstream's `dsh-api-workspace-files` service, which this fork does not carry. Local Session file authorization lives in `host/apiproxy`'s workspace-files domain, which calls the in-process `officeKit.convert()` with the identical `OfficeKitRequest` shape; `remote.spec.ts` and `RenderedDocumentBytes` go with the endpoints.
- **`fontMetadataCacheDirectory` Config field kept** — upstream office-kit does not expose it, but the local gateway plumbs a per-runtime font cache directory (`HGW_OFFICE_FONT_METADATA_CACHE_DIR`); kit `0.2.3` still accepts the option.
- **`tool-office` not absorbed** — its real-composition tests require upstream `dsh-tool-executor-native`/`-ptc` and `dsh-tool-testkit`, absent locally; it follows the tool-executor batch.
- libreoffice-kit `0.2.3` declares `fontkit` as a dependency, so the `0.1.1` dead-import patch does not carry; `0.1.x` pins remain only where `skill-office` still uses them.
- Upstream README edited: Remote-endpoint paragraphs rewritten to the apiproxy seam, a dead `apps/desktop` link retargeted, `tool-office` references marked as a later batch.

## Verification

- `pnpm exec vitest run packages/document/office-kit` — 120 tests pass.
- `packages/host/apiproxy` typecheck clean; `workspace-office.spec.ts` + `plugin-administration.spec.ts` — 8 pass.
- `gateway/tests/instances.spec.ts` — 111 pass (launch-stamp office-kit patch).
- `verify-md-links`, `verify-translation-pairing`, `verify-cordis-config`, `gen-cordis-catalog --check`, `verify-plugin-packages` — all green.
