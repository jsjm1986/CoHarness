# `@deepseek-ai/dsh-headless`

English | [中文](README.zh.md)

The dsh one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts PTC mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{task, sessionId, json, progress}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), resolves the Agent identity — a fresh `session-<uuid>` by default, or the exact persisted Session that `--session-id` names, adopted through `ctx.sessionQuery` and refused when no log exists, when the Session is already live in this process, or when its recorded cwd or agent preset does not match this run — submits the task as an ordinary user message, and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr. With `progress: true`, provider reasoning chunks are streamed to stderr; the default is `false`, so successful runs keep stderr empty. `--json` instead replaces the final-text line with a newline-delimited JSON event stream on stdout — an opening `session` event, `status`/`text`/`thinking`/`tool_call`/`tool_result` events projected at commit points, and a closing `final` event — while stderr keeps only `dsh:` diagnostics. The process opens no listening port. The task text is this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads the positional argument of `dsh --profile headless "task"` — or stdin when the argument is omitted or a lone `-` — plus the `--session-id` and `--json` options, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its run options from lazy config. A missing or whitespace-only task is rejected before the runner activates; in `--json` mode every usage error also writes an `error` event to stdout.

## Summary

`dsh-headless` runs one dsh task from the command line and prints the final answer, then exits — no GUI, no server, no browser. Type `dsh --profile headless "run the tests"` and the agent handles it with the same model, tools, and safety defaults as every other surface. It suits scripts, CI, and one-off jobs: it opens no ports and leaves nothing running behind. It also offers a JSON event stream (`--json`) and `--session-id` to resume a conversation. Exit code 0 means the task completed; 1 means it aborted or errored. The boundary: one task per invocation, no interactive follow-up.

## Model Experience

None, as the runner submits the task as an ordinary user message and the composed base and headless rows own the prompts and tools.

#### KV Cache effect

The runner adds nothing to the request prefix; it only drives one user message through the composed tree.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
- **Adoption is scoped** — `--session-id` requires the composed `sessionPersistence` and `sessionQuery` services and refuses a Session recorded in another working directory or under an agent preset this profile does not compose.
- **The event stream is a projection** — `--json` caps every string except the terminal `final` at 8 KiB and each line at 32 KiB, and omits events the projection does not model, so it is not a lossless copy of the Session log.
