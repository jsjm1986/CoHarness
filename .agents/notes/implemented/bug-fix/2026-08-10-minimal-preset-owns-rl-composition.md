# Agent Note: The minimal preset owns the complete RL agent composition

Status: implemented

English | [中文](2026-08-10-minimal-preset-owns-rl-composition.zh.md)

## Problem

The shipped Web configuration offered two owners for the Claude SWE-compatible RL agent: a process-wide `core-web.cordis.yml` patch and the per-session `minimal` preset. Once [agent presets](../architecture/2026-08-03-per-session-agent-presets.md) became the agent-composition boundary, the preset's scoped `deployment:persona` shadowed the overlay's corrected global persona with stale coding-agent text. The overlay test mounted no preset, while the preset test booted without the overlay, so neither exercised the composition users selected.

The split also hid other drift. The preset mounted one-shot Bash rather than the [persistent Bash](../feature/2026-07-29-persistent-bash-str-replace-editor.md) used by the RL harness and omitted the RL compaction policy. Keeping both owners makes every future prompt, tool, and policy change a cross-product.

## Decision

The shipped Web `minimal` preset is the sole Web owner of the RL agent composition. It declares an entry-local PTY registry and local backend and the platform-selected persistent shell — `bash`, or `pwsh` on Windows — with the RL environment description and 300-second timeout. Tool presentation remains a deployment choice. The [bare two-tool runtime decision](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.md) superseded this note's original compaction choice — the preset mounts no compaction backend — and the [persistent-shell-only decision](../simplification/2026-09-03-minimal-profiles-persistent-shell-only.md) later removed `str_replace_editor` and the preset-local `fs-local` provider, leaving the editor an explicit opt-in that a deployment patch inserts with a filesystem provider.

The preset persona is exactly `You are a helpful software engineer assistant.`, sets `complete: true`, and suppresses runtime context for its agent scope. A complete `PromptSection` participates in ordinary assembly so tools, variables, and cooperative listeners still resolve; after the `system-prompt/assemble` waterfall, the prompt registry restores a detached copy of that section as the sole system-prompt section and discards every dynamic context contribution. Multiple effective complete sections reject assembly. These final registry constraints prevent harness identity, Web orientation, tool guidance, an assembly listener, sandbox policy, approval policy, delegation, or another dynamic context provider from adding model input.

The process-wide `core-web.cordis.yml` patch is absent. Browser UI, workspace attachment, persistence, subprocess, sandbox, permission, model routing, and other cross-session services remain host-owned. Selecting `minimal` changes one agent's model-facing composition without changing other sessions in the Web process.

## Verification

System-prompt and persona package tests prove final complete-section and runtime-context suppression, including waterfall mutation and duplicate rejection. The shipped-preset composition test asserts the exact prompt, shell description, and persistent-shell roster under the default native presentation. The keyless Web replay sends a real request through a `minimal` agent while global identity, Web-orientation text, dynamic policy contexts, and a test section are registered, asserts that no system-prompt runtime-context section reaches the assembled request, no preset-local filesystem service is mounted, and compaction is absent, then executes two persistent Bash calls to prove environment and cwd state survive.

The standalone [`minimal.cordis.yml`](../../../../examples/jsonrpc-agent/minimal.cordis.yml) is the complete two-tool composition for the bundled JSON-RPC runtime. The [bare two-tool runtime decision](../feature/2026-08-11-minimal-profiles-bare-two-tool-runtime.md) owns its launch-specific environment configuration, bare filesystem, and absence of compaction. Its keyless SDK replay asserts the assembled system prompt and two-tool catalog, executes persistent Bash across calls, and exercises the editor; the Python SDK tutorial provides the runnable entry point.

## Alternatives considered

**Keep `core-web.cordis.yml` as a compatibility patch.** Rejected because a process patch and a session preset are two independent owners for one agent contract; precedence makes either one capable of silently undoing the other.

**Disable every known prompt contributor in the preset.** Rejected because host rows are process-wide and new contributors would reopen the prompt. A final complete-section constraint expresses the negative guarantee at the registry that assembles the prompt.

**Filter sections only with a prepended waterfall listener.** Rejected because another prepended wrapper can run outside it and append after the filter. Enforcement after the complete waterfall has stable final authority.

**Mount PTY services on the Web host.** Rejected because only the minimal agent consumes them. An entry-local `pty` realm gives the services the same lifetime and scope as their sole consumer without publishing a process-global service from a preset.

## Consequences

The Web RL prompt is fixed rather than environment-overridable; the standalone JSON-RPC prompt is deployment-selected. The Web preset composes a single platform-selected persistent shell — `bash`, or `pwsh` on Windows — while the standalone JSON-RPC example retains the persistent-shell-plus-editor contract; shell state is per agent and disappears with that agent. The Web preset pays for its own PTY service instances, while other presets pay nothing for them.
