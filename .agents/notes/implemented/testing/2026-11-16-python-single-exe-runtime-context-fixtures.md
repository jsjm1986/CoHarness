# Agent Note: Python single-exe smoke fixtures re-aligned to the fork's runtime-context text

Status: implemented

English | [中文](2026-11-16-python-single-exe-runtime-context-fixtures.zh.md)

## Problem

The python release-shaped matrix compared packaged-executable output against
fixtures re-recorded while the tree briefly carried the upstream intro
`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`
The absorbed agent-loop change kept the fork's own intro
(`The following information describes your current session:`), so the emitted
text was correct product behavior and the fixtures were stale. The fork also
emits `subagent:identity`, `tool:subagent_fork:depth`, and `subagent:delegation`
sections that upstream's recording lacked, so every stale fixture needed both
the intro sentence and the section inventory corrected, not a one-line swap.

`RUNTIME_CONTEXT_PREFIX` in `scripts/smoke-python-runtime.py` drives the
normalizer that drops the platform-variable runtime-context block from
model-visible comparisons. It named only the upstream intro, so a block
starting with the fork's intro survived stripping and would fail the same
comparisons on the platforms that emit it.

## Decision

- `scripts/smoke-python-runtime.py`: `RUNTIME_CONTEXT_PREFIX` →
  `RUNTIME_CONTEXT_PREFIXES = ("Current runtime context", "The following
  information describes your current session")`; both strip points use
  `str.startswith(tuple)`.
- 15 fixture files under `scripts/snapshots/python-sdk-single-exe/`
  (`advanced`, `advanced-ptc`, `restart`, `scheduler-recovery`, `authoring`):
  intro sentence replaced; root-session composites gained the root
  `subagent:identity` tail and section; delegated composites gained the
  agent-id identity sentence and the `tool:subagent_fork:depth` section while
  keeping `tool:subagent:depth`/`subagent:delegation`, pinned through the
  scenario's `{{agent-1}}`/`{{agent-2}}` placeholders.
- `gateway/tsconfig.build.json`: map `@deepseek-ai/cordis` to
  `vendor/cordis/lib/types` — the production `tsc -p tsconfig.build.json`
  overrides the parent `paths` map, so the vendored import only resolved
  through a local `node_modules` symlink that `npm ci` never creates; the
  windows-native lane hit TS2307 the first time its specs passed far enough
  to reach the build step.
- `.github/workflows/release-vendor.yml`: `NODE_OPTIONS
  --max-old-space-size=12288` — a called workflow does not inherit the
  caller's `env`, and `pnpm run build:lib:host` (direct `tsc -b
  tsconfig.host.json`, outside `compile-referenced-projects.ts` heap flags)
  OOMed at the default ~4 GB.
- `scripts/no-unknown-casts.baseline.json`: inventory regenerated for the
  rc.3-absorbed cast set (fingerprints are content hashes, so any edited cast
  reads as new).

## Consequences

- The linux `python runtime / release-shaped matrix` lane replays the same
  expected files the macOS lane records; root vs delegated identity tails are
  pinned per session file through the existing `{{agent-*}}` normalization, so
  the fixtures stay platform-independent.
- Local re-recording via `--update-snapshots` stays preferred when available;
  the packaged runtime cannot spawn its bundled shell on macOS and the office
  scenario needs the linux-only bundled node layout, so the deterministic
  transform reproduced the generator's own JSON/JSONL serialization and CI
  remains the verification surface.

## Alternatives considered

- Absorbing upstream's `supersedes`-style intro instead was rejected: the fork
  banner is the absorbed decision recorded in the alignment ledger, and every
  product snapshot outside this directory already carries it.
