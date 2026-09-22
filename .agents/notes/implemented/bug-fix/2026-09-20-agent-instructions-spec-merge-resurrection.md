# Agent Note: Restore agent-instructions spec after merge resurrection

Status: implemented

English | [中文](2026-09-20-agent-instructions-spec-merge-resurrection.zh.md)

## Problem

`agent-instructions` shipped `src/` byte-identical to upstream `dsh-v0.1.6-alpha.2` — including the `renderAgentInstructions` / `renderAgentInstructionSet` names — while `tests/agent-instructions.spec.ts` still imported the pre-rename `renderWorkspaceContext` / `renderWorkspaceInstructionSet` symbols. The spec also hand-rolled inbox helpers that upstream had since moved into `dsh-agent-loop-testkit`, so 84 of its 154 tests failed against the current implementation and the host aggregate typecheck reported unresolved imports. A merge of upstream branches that still carried the old names had overwritten the spec half of the earlier rename commit while leaving the `src/` half in place, leaving the file permanently inconsistent.

## Decision

Adopt the upstream alpha.2 spec and e2e wholesale rather than repair the resurrected file piecemeal: `src/` already matched upstream exactly, so the upstream test pair is the authoritative contract. The package manifest gained the imports the upstream tests actually need — `dsh-agent-loop-testkit` and a peer/dev `dsh-session-projection` — plus the `dsh-util-values` runtime dependency `src/files.ts` had been resolving through transitive hoisting, and `tsconfig.json` gained the `session-projection` project reference.

## Alternatives considered

**Repair the resurrected spec in place** (rename the symbols, keep the hand-rolled inbox helpers). Rejected: the file's behavioral expectations were also stale — 84 tests failed for reasons beyond the missing exports — so each repaired expectation would still be a fork-local guess rather than a verified contract.

**Delete the stale spec.** Rejected: the package's only coverage of baseline composition and inbox synchronization lives there; dropping it would leave the workspace-context seam untested.

## Consequences

`packages/context/agent-instructions` has no fork-owned spec text left; future upstream spec updates merge cleanly. Any local behavioral change must now be made deliberately in `src/` and in the spec together instead of silently diverging through a stale copy.

## Testing

`pnpm exec vitest run packages/context/agent-instructions/tests/agent-instructions.spec.ts` — 155/155 green. `pnpm exec tsc -b tsconfig.host.json` reports no `agent-instructions` errors.
