# @deepseek-ai/dsh-shell

English | [中文](README.zh.md)

The **`ShellExecutor`** (`ctx.shell`) defines WHAT a bash backend does — run foreground commands and start background processes — without saying HOW. Job ids, ownership, collection, cancellation, and notices belong to the generic `ctx.jobs` runtime.

This package owns the Service Definition role of the bash capability, split so each role can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-shell` (this) | Service Definition: abstract service + vocabulary types |
| `@deepseek-ai/dsh-bash-local` | Service Provider: local subprocesses |
| `@deepseek-ai/dsh-bash-sandbox` | Service Provider: `dsh-bash-local`'s mechanics with every spawn confined via [`ctx.sandbox`](../../sandbox/sandbox/), denials reported as result facts |
| `@deepseek-ai/dsh-tool-bash` | the model-facing tool schemas over `ctx.shell` |

The split is a standard capability seam ([capability-seams Agent Note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): `dsh-bash-sandbox` is a sandboxing executor behind the same Service Definition — the Consumer detects its `sandboxMode` capability and adds escalation fields without importing the provider — and a containerized or remote executor slots in the same way.

## Summary

Use `ctx.shell` to run foreground shell commands with bounded output or prepare background processes asynchronously before receiving their handles. A profile can select local or sandboxed Bash or PowerShell execution without changing callers. Resolve each request before execution to make the working directory, timeout, and output limits explicit. Command completion, nonzero exits, timeouts, and caller aborts return results; only infrastructure failures reject, while the `bash` and `pwsh` tools own model-visible rendering and sandbox guidance.

## Service API (`ctx.shell`)

| Member | Semantics |
|---|---|
| `run(spec)` | Foreground execution. Resolves when the command finishes. **Rejects only for infrastructure failures** (unusable workdir, missing shell, pre-aborted signal); nonzero exits, timeout kills, and abort kills resolve with a descriptive `ShellRunResult`. |
| `start(spec)` | Background execution. Returns a task-free `ShellProcess` handle immediately; **no timeout applies**. The caller may adapt it into `ctx.jobs`. |
| `sandboxMode` | The capability fact for the tool layer: the default mode a SANDBOXING executor confines under (`undefined` in the base class — "this executor does not sandbox"). `dsh-tool-bash` reads it at registration to advertise the escalation fields only when the composition honors them. |
| `ShellProcess.readOutput()` | **Incremental** output read — consecutive reads never re-deliver. Reads that lost data to buffer bounds flag `lossy` and point at full-stream spill files. |
| `ShellProcess.kill()` | Kill the process group. Returns `false` when it already finished. |

Implementations subclass `ShellExecutor` and implement the abstract methods. Disposal must kill every running process and await its exit.

`SHELL_SETTINGS_NAMESPACE` (`bash`) is exported here rather than by a provider because it names the capability, not an implementation. A host composes exactly one provider of `ctx.shell` — the win32 layer swaps the POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate service registration — so every provider can register this one namespace with its own schema and composition entry without two of them ever colliding, and a `settings.yaml` carried between platforms keeps resolving on both.

## Vocabulary

`ShellExecRequest` (command, workdir?, timeoutMs?, stdoutMaxBytes?, signal?, stdin?, env?, dshEnv?, sandboxPolicy?) resolves to `ShellExecSpec` (command, workdir, timeoutMs, stdoutMaxBytes, signal?, stdin?, env?, dshEnv?, sandboxPolicy) before execution. `stdoutMaxBytes` is a trusted foreground-run capture budget for consumers that must parse complete bounded stdout; the model-facing bash tool does not expose it. `sandboxPolicy` is optional on the request and required-but-nullable on the resolved spec: it carries the complete per-call mode and workspace root. The sandbox tool path resolves it from the calling session through `ctx.sandboxPolicy`; a direct sandbox-executor caller falls back to deployment policy, while a non-sandboxing executor carries the field and confines nothing.

The per-session sandbox-mode override vocabulary (the `'sandbox/mode'` event, the `effectiveSandboxMode(events)` fold, and the `setSandboxMode(session, mode)` write path) is NOT here — it is policy state shared by every enforcing family, owned by [`@deepseek-ai/dsh-sandbox-policy`](../../sandbox/sandbox-policy/). `run()` returns `ShellRunResult`; `start()` returns `ShellProcess`, whose incremental read and kill methods are adapted by `dsh-tool-bash` into a generic task registration. A sandboxing executor stamps `ShellSandboxInfo` on foreground results and settled process handles. See `src/types.ts` and [subsystems/shell.md](../../../docs/subsystems/shell.md).

`stdin` and ordinary `env` are set by in-process plugins (the hooks bridges, native plugins) to feed a hook command its JSON payload and `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT` values. `dshEnv` is a separate trusted overlay restricted by type to managed keys; the exported `DSH_ENV_PREFIX` is the single source for that namespace, its `DshEnvironmentKey` template type, executor scrubbing, registry validation, derived built-in names, and model guidance. Model bash uses the current snapshot collected by `ctx.shellEnv`. Implementations remove inherited managed keys, then merge `dshEnv` after ordinary `env`, so an omitted current fact cannot fall back to stale ambient state and an `env` entry cannot displace a managed value. The model-facing tool exposes none of these as parameters. All three remain optional on the resolved spec; absent means no input/overlay. See [the bash-stdin-env Agent Note](../../../.agents/notes/implemented/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.md) and [the session environment Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-agent-session-identity-and-log-location.md).

The exported `parseExitStatus` (with `ParsedExitStatus`) reverses the trailing `[exit code: N]` / `[exit code: null]` / `[killed by signal: X]` markers appended by the Bash and PowerShell renderers. An explicit unknown code stays `null`; an unrecognized marker stays in the output body. Both tools’ `presentResult` use this shared parser to separate output from terminal status without changing model-visible text.

## Invariants

**Runtime invariant:** No companion is published. The seam defines the executor contract; job ids, ownership, and cancellation belong to the generic `ctx.jobs` runtime.

## Model Experience

Indirectly, through `dsh-tool-bash`, which turns executor output and sandbox facts into guidance and retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No interactive-input vocabulary** — `stdin` is written once at spawn and closed; the seam has no channel to feed a running task and no PTY session concept.
- **Foreground timeouts are always executor-owned** — a caller-owned-deadline mode on the seam is explicitly deferred by [the tool-call timeout-policy Agent Note](../../../.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.md).
