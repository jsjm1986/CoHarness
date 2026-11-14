# Agent Note: Upstream office-kit absorption replacing office-to-pdf

Status: implemented

English | [中文](2026-11-25-upstream-office-kit-absorption.zh.md)

## Problem

Upstream rc.3 replaced `office-to-pdf` with `packages/document/office-kit` as the document-conversion seam, and the local consumers (apiproxy workspace-files, gateway launch-stamp, skill-office) still rode the old package. Upstream's kit also carries surfaces this fork does not share — Remote endpoints resolve Session files through upstream's `dsh-api-workspace-files` service, which does not exist here.

## Decision

Absorb upstream `packages/document/office-kit` as the `ctx.officeKit` Host service, replacing `office-to-pdf`, rewire every consumer, and move libreoffice-kit to `0.2.3` while dropping the upstream-only Remote endpoints in favor of the local apiproxy seam.

## Consequences

- **`render`/`generation` Remote endpoints are absent** — local Session file authorization lives in `host/apiproxy`'s workspace-files domain, which calls the in-process `officeKit.convert()` with the identical `OfficeKitRequest` shape; `remote.spec.ts` and `RenderedDocumentBytes` went with the endpoints.
- **`fontMetadataCacheDirectory` stays in `Config`** — the local gateway plumbs a per-runtime font cache directory (`HGW_OFFICE_FONT_METADATA_CACHE_DIR`); kit `0.2.3` still accepts the option.
- **`tool-office` was absorbed in the later executor-seam batch** — its real-composition tests required `dsh-tool-executor-native`/`-ptc` and `dsh-tool-testkit`, which landed first.
- libreoffice-kit `0.2.3` declares `fontkit` as a dependency, so the `0.1.1` dead-import patch does not carry; `0.1.x` pins remain only where `skill-office` still uses them.

## Alternatives considered

- **Keep the upstream Remote endpoints** — rejected: they resolve Session files through upstream's `dsh-api-workspace-files` service, which this fork does not carry; the apiproxy workspace-files domain already provides equivalent authorization in-process.

## Verification

- `pnpm exec vitest run packages/document/office-kit` — 120 tests pass.
- `packages/host/apiproxy` typecheck clean; `workspace-office.spec.ts` + `plugin-administration.spec.ts` — 8 pass.
- `gateway/tests/instances.spec.ts` — 111 pass (launch-stamp office-kit patch).
- `verify-md-links`, `verify-translation-pairing`, `verify-cordis-config`, `gen-cordis-catalog --check`, `verify-plugin-packages` — all green.
