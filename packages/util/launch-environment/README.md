---
description: "Immutable DeepSeek Harness launch environment that records which layer supplied each value"
kind: "package-library"
---

# dsh-launch-environment

English | [中文](README.zh.md)

This run's environment as one immutable snapshot that remembers **which layer supplied each value**. Consumers resolve user-facing values against it instead of `process.env`, because the layers are not equally trusted and a flattened view cannot tell them apart.

| Layer | Source id | What it is |
|---|---|---|
| Inherited process environment | `process` | What the launching shell, CI job, or container passed in — this run's explicit intent |
| `<invocation cwd>/.env` | `project-env` | The project the harness was launched in, which the product trusts to configure its own agent |
| `$DSH_HOME/.env` | `user-env` | The user's own machine-level defaults |

Values do also reach `process.env` — a user's `--config` tree and third-party libraries read it — but that flattened view is not the authority for anything the harness resolves.

## Summary

Use `@deepseek-ai/dsh-launch-environment` to resolve launch-time environment values without trusting the flattened `process.env`. It freezes inherited process values, the invocation directory's `.env`, and the Harness home's `.env`, then returns the winning value and its source in a fixed trust order. Callers can exclude layers for sensitive lookups; an omitted layer stays unreachable regardless of later ordering changes. The snapshot is immutable, but every layer is still copied into `process.env`, so it does not isolate subprocesses. Import it as a library; it cannot be mounted from `cordis.yml`.

## Table of Contents

- [Resolving](#resolving)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="resolving"></a>
## Resolving

`get(name)` searches every layer, most trusted first. `getFrom(name, sources)` searches only the named layers without changing that trust order.

**Omitting a layer is a refusal, not a demotion** — a caller that must never accept a layer leaves it out of the list, so no future reordering can let it back in. The provider adapters name all three, because the product trusts the project it runs in; the mechanism exists for the decisions where that is not true.

Names match the way the platform matches them: exactly on POSIX, case-insensitively on Windows. A case-sensitive lookup there would rank the wrong layer — a shell's `deepseek_api_key` and a project `.env`'s `DEEPSEEK_API_KEY` are one variable to the OS, and treating them as two would let the project win.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

declare const ctx: Context
const endpoint = launchEnvironmentOf(ctx).get('DEEPSEEK_BASE_URL')?.value
```

`launchedThroughSsh(snapshot)` returns true only for a non-empty `SSH_CONNECTION` or `SSH_TTY` in the inherited process layer. Web browser handoff, the adaptive directory picker, and Open In share this predicate; project and user `.env` values never establish an SSH session.

### How layers rank

| Layer | What it is |
|---|---|
| Inherited process environment | What the launching shell, CI job, or container passed in — this run's explicit intent |
| `<invocation cwd>/.env` | The project the harness was launched in, which the product trusts to configure its own agent |
| `$DSH_HOME/.env` | The user's own machine-level defaults |

Names match the way the platform matches them: exactly on POSIX, case-insensitively on Windows. A case-sensitive lookup on Windows would rank the wrong layer — a shell's `deepseek_api_key` and a project `.env`'s `DEEPSEEK_API_KEY` are one variable to the OS.

### When no launcher booted the tree

`launchEnvironmentOf(ctx)` returns the launcher's snapshot when the product CLI booted the tree, and otherwise the inherited environment as the only layer. The fallback does not weaken the rules: an SDK host or a bare `cordis.yml` discovered no files, so everything it has is the environment it was launched with.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The snapshot is built on one separation: the launcher owns which files exist, and the snapshot owns how values rank.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createLaunchEnvironmentSnapshot`, `launchEnvironmentOf`, and the `ctx.launchEnvironment` slot |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher that builds the snapshot or the consumers that resolve through it.

- [Boot package](../../boot/app-boot/README.md) — the launcher that fills `ctx.launchEnvironment` before any config entry mounts.
- [Credentials store](../../credentials/credentials-local/README.md) — resolves stored credentials against the snapshot's layers.
- [DeepSeek provider](../../llm/llm-deepseek/README.md) — reads provider configuration through the launch environment.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The snapshot is not a subprocess boundary** — every layer is also materialized into `process.env`, so ordinary project variables reach child processes under [`dsh-subprocess`](../../subprocess/subprocess/README.md)'s scrub. The product launcher's [`.env` contract](../../boot/app-boot/README.md#profiles) rejects bootstrap variables before materialization.
- **No per-workspace layer** — the project layer is the *invoking* directory, fixed at launch. A workspace selected later in the Web UI contributes nothing, deliberately: following it would let a model's own workspace change the harness environment mid-session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
