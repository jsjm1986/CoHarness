# Agent Note: dsh-tool-fs registers its tools behind per-tool switches

Status: implemented

English | [中文](2026-10-21-tool-fs-registration-switches.zh.md)

## Problem

`dsh-tool-fs` unconditionally registered `read`, `read_image`, `write`, and `edit`, so a composition could not offer the filesystem tools selectively. The `sdk-minimal` bundle already shipped `config: { read: false, readImage: true, write: false, edit: false }`, but the keys were not in the plugin's `Config` schema and were silently ignored: the minimal profile exposed the full mutation suite, and the keyless smoke asserting `[bash, read_image, working_directory]` could only fail once the provider-proof lane actually ran it on a pull request — master's topology skips that lane entirely.

## Decision

`Config` gains four independent switches — `read`, `readImage`, `write`, `edit`, each defaulting to `true` — and `apply` gates each tool's registration on its switch: `read` guards `applyReadTool`, `readImage` guards the attachment-conditional `read_image` mount, and `write`/`edit` share the `FsSandboxController`, which is only constructed while at least one mutating tool registers. With `read` disabled, `write` and `edit` still function: a successful mutation records the version the session needs for later mutations, so newly created files remain editable while existing unobserved files stay protected by `fs-observation-policy`.

## Alternatives considered

- **Fix the expectation to the full suite** — would ratify the silent no-op configuration and leave `sdk-minimal` exposing mutating tools its manifest says are off; the defect is in the plugin, not the test.
- **Remove the dead config keys instead** — `sdk-minimal`'s read-only filesystem posture is a product choice worth keeping; deleting the keys preserves the lie differently.
- **Gate on observation-policy presence instead of config** — coupling tool registration to an optional plugin's mount state hides a deployment decision inside an unrelated capability; the switches are the explicit mechanism.

## Consequences

Compositions can now ship any subset of the filesystem tools, and `sdk-minimal` exposes exactly the suite its patch declares. Deployments that relied on the silently ignored keys get the behavior they already asked for — an observable reduction of model-facing tools, which is the intended consequence rather than a compatibility break, because the registered set was never the contract the config promised.
