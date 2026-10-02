# Agent Note: Legacy deepseek catalog ids retained over pi-ai 0.87 renames

Status: implemented

English | [中文](2026-10-02-legacy-deepseek-catalog-aliases.zh.md)

## Problem

pi-ai 0.87.1 renamed `deepseek-v4-flash` to `deepseek-flash` (DeepSeek V4.1 Flash) and dropped `deepseek-v4-flash-vision-exp` from its installed catalog. This deployment's session logs, settings documents, composition profiles, and snapshot fixtures name the 0.85-era ids — over a thousand committed files, including immutable session-log generations that cannot be rewritten. Without retention, a catalog route resolves those ids to nothing and the stream ends empty.

## Decision

`catalogModels` merges `LEGACY_MODEL_ENTRIES` into the installed catalog map: one `Model<Api>` entry per legacy id, carrying the 0.85-era metadata verbatim — including the wire `id` — so requests, replay validation, and selector listings behave exactly as they did before the upgrade. An alias is skipped if the installed catalog ships the id itself, so the table shrinks naturally when pi-ai restores a name.

## Alternatives considered

**Patch `deepseek.json` in the pi-ai patch file.** Rejected: the data file is a single minified line, so the patch hunk would pin the entire catalog blob and fail on every upstream catalog refresh; a fork-side table expresses the same fact in two reviewable entries.

**Rename the fork's ids to `deepseek-flash`.** Rejected: committed session generations are immutable and settings documents in the field name the old id, so the rename could never complete.

**Clone the successor's metadata under the old id.** Rejected: V4.1's image input and higher pricing would silently over-claim what a `deepseek-v4-flash` request serves; the 0.85 metadata is the last proven contract for that wire id.

## Consequences

- `deepseek` catalog routes list two extra entries the installed registry does not name; assertions comparing against `getBuiltinModels` account for them explicitly.
- A pi-ai upgrade that restores either id makes its table entry a no-op that can be dropped.

## Testing

`adapter.spec.ts` streams `deepseek-v4-flash` through the alias entry; `catalog.spec.ts` and `discovery.spec.ts` pin the alias presence in listing and discovery output.
