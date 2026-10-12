# Agent Note: Python PTC runs under the shared file sandbox policy

Status: implemented

English | [中文](2026-10-12-python-ptc-shared-sandbox-policy.zh.md)

## Problem

`PythonPtcRuntime` rejected every `request.sandboxPolicy` with "sandbox policy is unsupported" and spawned model programs in an unconfined `python3` process, while the Node PTC runtime already ran under the shared `sandbox`/`sandboxPolicy` services. The `run_code` tool advertises `sandbox_permissions` escalation only for runtimes that report a `sandboxMode`, so Python programs could neither be confined nor escalate — file effects were limited only by the process UID, not by policy.

## Decision

Port upstream `11a0f85b340` onto the CoHarness package. The runtime declares `inject = ['sandbox', 'sandboxPolicy']`, reports `sandboxMode` from the policy service's default mode, resolves `request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`, derives `cwd` from `request.cwd ?? sandboxPolicy.workspaceRoot`, and spawns through `ctx.sandbox` as a `ConfinedArgv`. Trusted `bootstrap.py`/`protocol.py` sources now reach the interpreter on stdin through `PYTHON_BOOTSTRAP_LOADER`/`bootstrapInput()` instead of per-run tempdir copies, so confinement no longer depends on sandbox-visible staging files; `LiveRun` settles through an `AbortController`. Execution instructions state that direct filesystem access follows the execution's sandbox policy, which lets `run_code` expose `sandbox_permissions`/`justification` for Python runs.

## Alternatives considered

**Keep rejecting `sandboxPolicy`.** Rejected: the tool and the request type already carried the field, and silently unconfined Python execution contradicted the policy the Node runtime enforces.

**Keep the per-run tempdir script copy.** Rejected: a confined child cannot read host temp files reliably, and stdin loading also removes the copy race the old comment documented.

## Consequences

Python runs now follow the standing file policy and may request one-shot escalation through the same approval path as Node runs; a sandbox denial surfaces through the run's `sandbox.denied` field. Sessions recorded before this change show a different `run_code` schema; the generated catalogs and the `ptc-python-turn` expected schema record the new model-visible text. The upstream `ptc-python-read-only` snapshot fixture is not carried: it was recorded against upstream's v4 codec and `working-directory` context section, neither of which our current codec generation admits; `sandbox.spec.ts` covers the denial paths in process.

## Verification

`packages/experimental/ptc-runtime-python/tests/` covers confined argv, policy resolution, escalation denial, protocol frames, and stray-fragment handling (325 tests, 2 platform-skipped); the package typechecks clean and `pnpm run test:snapshot` replays `ptc-python-turn` against the regenerated schema.

## Related

- [DeepSeek request-extension resilience](2026-10-12-deepseek-request-extension-resilience.md) — the same alpha.2 alignment batch.
- Upstream commit: `11a0f85b340` (shared sandbox policy for Python execution).
