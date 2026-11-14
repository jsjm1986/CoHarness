# Agent Note: Upstream PTC runtime refactor absorbed from dsh-v0.2.2-rc.3

Status: implemented

English | [中文](2026-11-14-upstream-ptc-runtime-sync.zh.md)

Upstream `rc.2..v0.2.2-rc.3` replaced the `persistent.ts`/channel design of
`ptc-runtime-node` with a modular evaluator/execution/worker/RPC architecture
(configuration, async-function/REPL/VM-Script evaluators, top-level-await
rewriting, import hooks, bootstrap validation, nested tool-call budget).
We adopted the package wholesale and replayed only the local API adaptations.

## Local adaptations kept

- `ctx.subprocess.spawn` is async here; every spawn call site awaits, and two
  tests that assumed a synchronous handle were adjusted
  (`persistent.spec.ts` awaits the bound spawn; `host-failures.spec.ts`
  defers its forged transport loss to a macrotask — note that spec file's
  `setImmediate` import is the `timers/promises` variant, so a plain
  `setImmediate(cb)` would silently never run the callback).
- `SandboxExecutionPolicy` has no `additionalWritableRoots`; execution clones
  the policy verbatim until the sandbox batch lands that field.
- `HarnessError` comes from `@deepseek-ai/dsh-llm` (upstream's
  `dsh-error` package does not exist here).
- `sandbox-policy` registers its keyed projection through the local
  `ctx.sessionProjections.register({ key })` / `stateOf(session, key)` API
  rather than upstream's handle-returning variant.
- Locale additions (`de/es/fr/ja/pt/ru`) were excluded by sync policy.

## SessionStore lifecycle guards carried along

The upstream append guards the refactor relies on were backported to
`packages/core/session`: a `pending | dispatching | complete | failed`
announcement state machine and a `WeakMap<Session, SessionEntry | null>`
attachment table, so appends after detach or before `session/created`
completes fail loudly instead of silently going store-less.

## Verification

`vitest run packages/ptc-runtime/ packages/sandbox/ packages/core/session/`:
64 files, 1470 tests, all passing (7 platform-gated skips).
