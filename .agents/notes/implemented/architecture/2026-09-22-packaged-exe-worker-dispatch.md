# Agent Note: The packaged JSON-RPC executable dispatches worker modes by environment selector

Status: implemented

English | [中文](2026-09-22-packaged-exe-worker-dispatch.zh.md)

## Problem

The Python single-file executable re-invokes itself for every subprocess-carrying worker: the PTC Node runtime spawns `process.execPath` with `DSH_PTC_RUNTIME_NODE=1`, and the subprocess provider's scoped runners spawn it with `DSH_SUBPROCESS_RUNNER=<locator>`. The packaged bin only booted a JSON-RPC agent composition, so every worker spawn exited with the agent's `usage:` line instead of running the worker, and `tools.mode: both` compositions could never execute `run_code` inside the packaged runtime.

## Decision

`packaged-bin.ts` is the executable's single dispatch point, ordered before the agent boot:

1. On Windows, `argv[2]` equal to the resolved `@deepseek-ai/dsh-sandbox-windows-acl/runner` entry runs the ACL runner (the injected snapshot entry is spliced out of `argv` first).
2. `DSH_PTC_RUNTIME_NODE === '1'` deletes the selector and side-effect imports `@deepseek-ai/dsh-ptc-runtime-node/process`, which opens the inherited control channel and runs the worker protocol.
3. `DSH_SUBPROCESS_RUNNER` set deletes the selector and calls `runSelectedSubprocessRunner(selection)` from `@deepseek-ai/dsh-subprocess-local/runner`.
4. Otherwise the bin runs `runJsonrpcAgent(import.meta.url)` unchanged — `bareModuleBaseUrl` stays scoped to the agent arm because worker arms resolve nothing through it.

Each selector is deleted after reading so a worker child that re-invokes the executable does not re-dispatch on the same arm. `jsonrpc-demo` declares all three packages as `dependencies` so the exe build's closure walk stages their `lib/runner*.js` and `lib/process*.js` artifacts.

## Alternatives considered

**Pass the composition to worker children.** Rejected: a PTC worker does not boot a cordis composition — it runs the private worker protocol over an inherited control channel; forwarding `DSH_CORDIS_CONFIG` would boot a second agent stack and still provide no channel.

**Split worker entries into separate executables.** Rejected: the packaging pipeline ships one binary; worker re-invocation through `process.execPath` is what keeps spawn targets real files under pkg's virtual filesystem.

## Consequences

`tools.mode: both`, scoped subprocess runners, and workflow workers function inside the packaged runtime; the `smoke-python-runtime.py` custom composition exercises the `run_code` path end-to-end. The cost is a dispatch block the agent arm does not exercise, carried under `v8 ignore` because only the built executable reaches it.
