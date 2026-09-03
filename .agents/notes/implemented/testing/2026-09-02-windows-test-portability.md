# Agent Note: Windows lane tests assert platform facts, not POSIX spellings

Status: implemented

English | [中文](2026-09-02-windows-test-portability.zh.md)

## Problem

The `windows node 24 / native complete` lane ran for the first time on a GitHub-hosted `windows-2025` runner once [portable runner defaults](../process/2026-09-02-portable-ci-runner-defaults.md) replaced the never-provisioned enterprise pool. Its `test:coverage` gate reported seven test files that pass on Linux and macOS and fail on Windows, and the first rerun on the fixed lane surfaced an eighth. None of them found a product defect: every failure was a POSIX or timing assumption written into the test itself, plus one maintenance script calling an operation Windows rejects.

- `userdoc-local/tests/name.spec.ts` built its document root as `join(sep, 'home', 'alice', 'uploads')`. On Windows that is a rooted but drive-less `\home\alice\uploads`; the code under test resolves it to `D:\home\alice\uploads`, so every equality against the literal root failed, and a "taken names" set keyed on the drive-less spelling never matched what the resolver produced.
- `userdoc-local/tests/store.spec.ts` asserted the saved file's mode is `0o600`. Windows has no POSIX permission bits and reports `0o666`.
- `directory-picker-browse/tests/service.spec.ts` granted `/` and listed `/etc`. Windows roots are drive-qualified and `/etc` is not a fully qualified path there.
- `apiproxy/tests/api-proxy-collaboration.spec.ts` configured the project root as `/tmp` and its project as `/tmp/project`. The Host canonicalizes the configured root through `realpath`; `D:\tmp` does not exist on the runner, so every project-scoped call failed with `gateway-unavailable` instead of exercising the containment rule.
- `tool-pwsh-persistent/tests/loader-composition.spec.ts` compared PowerShell's reported `cwd` with `realpathSync(root)`. The runner's temporary directory is handed out as an 8.3 short name (`RUNNER~1`) that only `realpathSync.native` expands to the long spelling PowerShell prints.
- `apps/cli/tests/shipped-preset-root.spec.ts` asserted a forward-slash `config/agent-presets` substring inside a path the launcher builds with the platform separator.
- `scripts/session-sqlite-migration.ts` opened the finished output read-only and `fsync`ed both it and its parent directory. Windows `FlushFileBuffers` needs a writable handle and rejects directory handles with `EPERM`.
- `session-persistence-sqlite/tests/sqlite.spec.ts` paced a busy journal-mode transition against the wall clock: a 50 ms busy budget was expected to yield two to six attempts. The budget is open-relative, and on the Windows runner creating and initializing the database file alone consumed it, so the first attempt already sat past the cutoff and the test saw one attempt.

## Decision

Each test now asserts the platform-independent fact it always meant to assert, using the same path primitives the code under test uses:

- The document root is `resolve(sep, 'home', 'alice', 'uploads')`, fully qualified on every platform, and the escaping path in the containment test is resolved the same way.
- The owner-only mode assertion and the filesystem-root grant test are declared with `it.skipIf(process.platform === 'win32')` and a comment naming the POSIX fact they depend on. The behavior stays covered on the platforms where it exists.
- The collaboration spec derives `PROJECT_ROOT` from `os.tmpdir()` and `PROJECT_DIR` from `join(PROJECT_ROOT, 'project')`, so the configured root exists on every runner and the containment rule is what the test exercises.
- The pwsh loader test expects `realpathSync.native(root)`, which resolves both the macOS `/var` → `/private/var` alias and Windows short names.
- The shipped-preset test expects `join('config', 'agent-presets')`.
- `finalizeOutput` in the migration script opens the output with `r+` and skips the parent-directory `fsync` on `win32`, where the directory entry is durable without it. POSIX behavior is unchanged.
- The pacing test drives `performance.now` with a controlled clock that advances 10 ms per busy attempt, the same technique its sibling cutoff test already used, so a 50 ms budget yields exactly five attempts on every runner and the file-creation cost no longer enters the measurement.

## Alternatives considered

**Exclude the seven files from the Windows lane.** Rejected because six of the seven test real cross-platform behavior — document naming, project containment, PowerShell cwd persistence, preset roots — and Windows is a supported host for all of it. Only the two assertions that are literally POSIX facts are skipped, per assertion rather than per file; the pacing test keeps running everywhere because the fact it asserts is the retry cadence, not the runner's disk speed.

**Normalize paths inside the code under test to satisfy the tests.** Rejected because the code was already correct: it resolves paths with `node:path` and the tests were comparing against spellings `node:path` never produces on Windows.

**Keep the directory `fsync` and swallow `EPERM`.** Rejected because a bare `catch` on a durability primitive hides genuine failures on the platforms where the call is meaningful. A platform branch states the actual constraint.

## Consequences

The Windows lane's remaining `test:coverage` failure is the shared per-file coverage debt tracked separately; no Windows-specific test failure remains. The collaboration spec's project root now depends on `os.tmpdir()` existing and being canonicalizable, which every supported runner guarantees. Two POSIX-only assertions are explicitly marked as such and would need a Windows-specific counterpart if the owner-only or root-grant contracts ever gain Windows semantics.
