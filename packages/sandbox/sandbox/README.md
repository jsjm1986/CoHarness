# @deepseek-ai/dsh-sandbox

English | [中文](README.zh.md)

Process-sandbox Service Definition. Owns the `ctx.sandbox` service contract ([`SandboxProvider`](src/index.ts)) and the confinement vocabulary the harness shares: `SandboxMode` (`read-only` / `workspace-write` / `danger-full-access`, file effects only), `SandboxEnforcement` (`full` / `partial`, per kernel ABI), `SandboxExecutionPolicy` (the complete per-call mode + workspace root), `SandboxPolicy` (its confined subset), and the fail-closed `SANDBOX_UNAVAILABLE` error. As the Service Definition role of the [capability-seam split](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md), it depends only on cordis (+ the harness error base), never on a backend.

The contract in one line: `ctx.sandbox.confine(argv, policy)` returns the argv to spawn INSTEAD of your own — wrapped so the process (and everything it spawns) runs confined — plus the selected backend's enforcement completeness, denial dialect (`denialSignatures`), and structured runner-failure evidence (`runnerFailureRules`); when no backend is usable it throws rather than passing the argv through unconfined. The [core type catalog](../../../docs/subsystems/sandbox.md#wrapped-argv-and-classification-dialects) owns the exact classifier shape.

Policy rides the call, not the provider: two consumers may confine under different policies at the same instant (bash under `read-only` while a confined child agent keeps its state directory writable), and an approved escalated retry is just a new call with a wider policy.

**Same-world confinement only.** A backend shares the host's filesystem and kernel (`bwrap`, Landlock, Seatbelt); `workspaceRoot` names the filesystem-canonical real host directory. Workspace identity is resolved before lexical normalization, so a valid cwd containing `symlink/..` grants the directory where `chdir` actually lands rather than an unrelated lexical parent. Containers, microVMs, and remote executors are NOT backends of this seam — they replace the Service Providers for whole capability seams (`ctx.shell`, `ctx.fs`) as environment-coherent groups. The boundary and its rationale: [the sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md).

Implementations: [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) (Linux: `bwrap`, else the per-platform Landlock launcher; macOS: `sandbox-exec`/Seatbelt). Consumers: [`@deepseek-ai/dsh-bash-sandbox`](../../shell/bash-sandbox/) (wraps `['bash', '-c', command]`).

## Summary

Use `dsh-sandbox` to run a subprocess and everything it spawns under a per-call file-access policy. A command can run without writes (`read-only`), write only inside its workspace (`workspace-write`), or run unrestricted (`danger-full-access`). If the requested mode cannot be enforced, the call fails with `SANDBOX_UNAVAILABLE` instead of running unconfined. After a denied call, the model can request one strictly wider mode for human approval. This is same-world confinement: the process still shares the host kernel and filesystem; use a container, microVM, or remote executor when the whole environment must be isolated.

## Model Experience

### Confinement error, indirectly

#### What the model sees

Through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) and [`dsh-tool-bash`](../../shell/tool-bash/README.md), a requested confined mode with no usable backend produces code `SANDBOX_UNAVAILABLE` and the exact error below; an execution-time runner failure appends ` Runner failure: <detail>`.

##### Exact error

```markdown
sandbox mode "<mode>" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL restricted-token runner can start (Windows) — otherwise switch the consumer to danger-full-access.
```

#### Token effect

Conditional error text is visible for that call and retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Escalation request and outcome

#### What the model sees

A denied call surfaces the marker `[sandbox: file access denied under <mode> mode]` and, where the composition advertises escalation, the hint `[sandbox: escalation available — retry this exact <subject> once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`. The retry carries `sandbox_permissions` and a `justification`; the user's `allowed-once` / `rejected` / `cancelled` decision becomes the call's result text.

#### Token effect

Only the denied call's error and any escalation outcome text are visible; both are retained in history until compaction.

#### KV Cache effect

Append-only; escalation text follows the retained prefix and does not invalidate cached entries.

## Known Limitations and Deferred Work

- **File effects are the whole policy vocabulary** — the seam expresses no network, process, syscall, device, or credential restrictions.
- **Same-world confinement only** — containers, microVMs, and remote execution require replacing capability implementations rather than adding a provider here.
- **Denial reporting is a stderr dialect** — the seam returns backend signatures instead of a typed runtime denial channel, so consumers that need classification must infer it from the child process's output.
- **Runner diagnostics are in-band** — exit status plus stderr evidence cannot prove which process wrote a matching line, so a confined child that deliberately mimics its runner can cause an availability/diagnostic false attribution. This cannot bypass confinement; an out-of-band runner-status channel is deferred.
- **One provider per context** — composing different sandbox mechanisms simultaneously requires a provider-level ladder or separate Cordis contexts; callers choose policy per call, not backend identity.
