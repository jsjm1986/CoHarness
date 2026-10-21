# Agent Note: CLI version-exemption commands

Status: implemented

English | [中文](2026-10-14-cli-version-exemption-commands.zh.md)

## Problem

The compatibility refusal machinery produces a `dsh plugin allow-version <package@version> --dsh-version <runtime> --accept-risk` command as its printed remediation, but `dsh plugin` forwarded every argument to pnpm, so the printed command reached pnpm and failed. Operators had no working path from a refusal to a grant; only the `plugin_manager` tool could write exemptions.

## Decision

`dsh plugin` intercepts three DSH-owned commands before pnpm forwarding; everything else still reaches pnpm unchanged.

- `version-exemptions` lists saved grants and read warnings without running pnpm.
- `allow-version <package@version> --dsh-version <runtime> --accept-risk` prints the risk warning, validates the exact package and runtime versions through `setProfileVersionExemption`, and saves the grant under the profile manifest write lock, the same lock package operations hold.
- `revoke-version <package@version> --dsh-version <runtime>` removes the grant under the same lock; revocation of a historical runtime grant succeeds without `--accept-risk`.
- Grants persist in the profile's own `compatibility.json` beside `package.json`; the file maps exact `name@version` keys to exact runtime versions and changes no dependency, bundle selection, or patch layer. Plugin and DSH upgrades do not inherit grants.
- A missing non-Desktop profile is initialized from `PROFILE_TEMPLATES`/`DEFAULT_PROFILE_BUNDLES` before the exemption file is written, matching `dsh plugin` package-operation behavior. The `desktop` profile must already exist — exemption commands will not initialize it, the same refusal package operations carry.
- `bin.ts` forwards the installation-owned `packageManager` runtime configuration into `runPlugin`, so Desktop-carrier invocations and ordinary invocations resolve pnpm identically to package operations.
- A compatibility refusal prints the exact `allow-version` command for each refused package, so the remediation stays accurate if the grammar ever changes in only one place — the command builder.

## Alternatives considered

**Keep exemptions tool-only.** The refusal diagnostics already printed the CLI command, so without an implementation the record pointed at a dead end; removing the printed command instead would strand operators on the tool path that CLI-only profiles cannot reach.

**Store grants inside `dsh.profile`.** Exemptions are per-package-version metadata with their own lifecycle — a grant outlives neither a plugin upgrade nor a DSH upgrade, and it must not be read as a composition directive. A sibling JSON file keeps the manifest a pure selection document and lets the lock file cover both writers.

## Consequences

Operators can complete the refuse → warn → grant → retry loop entirely from the CLI, and the Desktop bundled command manages the reserved profile's exemptions under the same lock as its package operations. `--accept-risk` is never implied: a grant without it fails before validation, and `acceptRisk` in the tool's `set_version_exemption` carries the identical contract. Revocation needs no acknowledgement because it only shrinks granted risk.

## Verification

`apps/cli/tests/plugin.spec.ts` — 22 cases cover command parsing, malformed-argument rejection, explicit acknowledgement, exact-version validation, profile defaults, Desktop restrictions, shared-lock ordering, pnpm forwarding, refusal remediation text, and package-manager forwarding. `apps/cli/tests/plugin-compatibility.expected.e2e.ts` runs the real pnpm flow against built `lib/bin.js`: refusal leaves the profile untouched, a granted exact pair admits installation and startup, and revocation restores the refusal.

## Related

- [Guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.md) — the registry-plan and rollback machinery the CLI commands share.
- [Plugin command registration](../../archived/feature/2026-07-19-plugin-command-registration.md) — the `dsh plugin` dispatch these commands extend.
