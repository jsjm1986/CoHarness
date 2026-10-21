# Agent Note: `dsh plugin` reads `--profile` only before forwarded pnpm arguments

Status: implemented

English | [中文](2026-10-18-plugin-option-placement.zh.md)

## Problem

`dsh plugin` forwards its remaining arguments verbatim to pnpm inside the profile's plugin directory. The fork's parser kept Commander's default option handling: `plugin --profile <name>` was a required option on the subcommand, but Commander would keep consuming `--profile` (and `-h`/`--help`) anywhere on the line — including inside what the operator meant as pnpm input. `dsh plugin add <pkg> --profile x` silently reinterpreted a pnpm flag as the forwarder's own option, and `dsh plugin --profile tui add --help` printed the forwarder's help instead of asking pnpm. Which flags belonged to the forwarder and which to pnpm was position-insensitive, so there was no reliable spelling for "forward this flag".

Upstream's v0.2.1-alpha.1 upgrade guide (`plugin-option-placement`) resolves the ambiguity the other way: the forwarder reads its own options only before the first forwarded argument, then passes everything through untouched. How does the fork adopt that contract without losing the subcommand's own help?

## Decision

`apps/cli/src/args.ts` gives the `plugin` subcommand Commander's pass-through semantics verbatim from upstream:

- `.helpOption('-h, --help', 'show this help')` restores a help flag on the forwarder itself — the launcher's disabled help option would otherwise be copied into the subcommand, leaving `dsh plugin --help` dead.
- `.passThroughOptions()` stops option consumption once forwarded positional arguments begin, so every token after the boundary — including `--help`, `-h`, and `--profile` — reaches pnpm verbatim.
- `.requiredOption('--profile <name>')` keeps its position before the boundary: it is read only while Commander is still consuming forwarder options, which is exactly the "profile first, then pnpm args" spelling every doc and smoke script already used.

## Alternatives considered

- **Keep position-insensitive parsing** — rejected: a `--profile` or `--help` inside pnpm arguments is silently eaten instead of forwarded, and there is no way to spell "forward this token" at all.
- **Require `--` as the explicit boundary** — rejected: upstream chose positional pass-through, so `dsh plugin --profile x add pkg` needs no separator; diverging would break the upgrade guide's contract and every already-correct invocation.
- **Split pnpm args from forwarder options by a different marker** — rejected for the same reason: any boundary other than "first forwarded argument" contradicts the adopted contract.

## Consequences

The contract is intentionally breaking: `dsh plugin add <pkg> --profile <name>` and `dsh plugin --filter x add --profile y` — which used to select a profile — now forward `--profile` to pnpm and fail the forwarder's required-option check. Scripts placing `--profile` after pnpm arguments must move it before them; repository docs and smoke invocations already used the correct order (`dsh plugin --profile sdk add file:<plugin>`), so no in-tree caller needed changing. `--help` after forwarded arguments now reaches pnpm rather than the forwarder.

## Verification

- `pnpm vitest run apps/cli/tests/args.spec.ts` — 58 tests pass, covering `--help`/`-h`/`--profile` forwarded after the boundary, leading pnpm options forwarded verbatim, both late-`--profile` placements failing, and `plugin --help` variants printing the forwarder's help.
