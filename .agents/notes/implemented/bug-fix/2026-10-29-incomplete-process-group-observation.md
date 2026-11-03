# Agent Note: Incomplete process tables retain group ownership

Status: implemented

English | [中文](2026-10-29-incomplete-process-group-observation.zh.md)

## Problem

Linux process-group fallback can observe a zombie while another process row is unreadable or malformed. Skipping the unknown row can report a zombie-only group even when its live descendant remains. A confirmed empty range permanently disables later signals and allows resource release, so an incomplete observation can abandon that descendant.

## Decision

The [process-group observer](../../../../packages/subprocess/subprocess-local/src/proc-stat.ts) returns unknown after any failed or malformed process row unless it finds a live member of the target group. Even a disappearing row leaves the scan incomplete: enumeration does not establish that the process exited without leaving descendants. Only a complete zombie-only observation permits that fallback result. Kernel process-group absence and native scope ownership retain their existing behavior and limitations.

Fallback POSIX [terminal cleanup](../../../../packages/subprocess/subprocess-local/src/terminal.ts) retains captured descendant identities across partial observations. Successful cleanup requires a final complete process table; an absent completeness declaration remains unverified. The final completeness check retries partial observations within the owning spawn’s configured `graceMs`, retaining captured identities throughout. Expiry with incomplete evidence fails cleanup. A failed cleanup leaves the handle retryable and the provider's host-exit callback retained. After observation recovers, exact identity checks fence signals and confirmed cleanup releases ownership. Windows queries each process identity directly and does not use POSIX table completeness to authorize cleanup.

POSIX per-identity live and snapshot queries preserve the same absence/unknown distinction. An absent row in an incomplete table rejects the observation; a visible row can still establish its own identity or prove that a different generation owns the PID. Linux direct stat reads accept `ENOENT` and `ESRCH` as absence and propagate other failures. Malformed or PID-mismatched stat data is not identity evidence; enumeration marks such rows incomplete. Terminal-wide completeness guards remain necessary because one identity does not establish the complete descendant range.

The [Windows inspector](../../../../packages/subprocess/subprocess-local/src/windows-inspector.ts) distinguishes an absent process from unreadable process state. `OpenProcess` with its fixed access flags treats `ERROR_INVALID_PARAMETER` as absence; access denial and other failures throw `Win32Error`. Failed creation-time reads and process-handle waits also throw. Toolhelp32 enumeration accepts only `ERROR_NO_MORE_FILES` as completion. These failures retain captured identities and cleanup responsibility, including after the root exits. This follows the documented [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess) and [wait](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject) failure results.

Native process-table and termination commands use the owning spawn’s positive `graceMs`, rounded up to a whole millisecond, for each helper’s execution deadline. A timed-out helper receives `SIGKILL`; returning from that helper never establishes workload quiescence. Query failure rejects observation, while best-effort `taskkill` delivery still requires independent workload exit confirmation. The process-query and termination factories require the deadline explicitly, including synchronous host-exit signalling. Per-helper deadlines do not bound complete teardown or uninterruptible kernel operations.

The real Loader regression uses an actual surviving POSIX child and injects the nondeterministic process-table input. Source and compiled provider transcripts require the shared exit wait to remain pending until termination removes the descendant. Unit cases cover permission denial, descriptor exhaustion, disappearing rows, malformed data and positive live-member evidence.

The [native PTY transcript](../../../../packages/subprocess/subprocess-local/tests/fixtures/terminal-clock-driver.mjs) captures a TERM-resistant descendant, kills the root, injects a partial process table and requires cleanup refusal with retained provider exit protection. Restoring observation permits retry to stop the real descendant before release. Linux and macOS unit scenarios separately require known identities to survive the failed observation.

Its Win32 observation scenario runs the actual Loader, provider and PTY with Win32 API inputs backed by real POSIX process identities. An injected access denial must retain the real surviving child and disposed provider exit callback until observation recovers. This checks cleanup decisions and native binding failure handling; it does not establish physical Windows execution.

## Alternatives considered

**Ignore disappearing rows.** A process can leave a descendant after enumeration and exit before its row is read. Missing rows therefore cannot establish a complete zombie-only observation.

**Return false for an unreadable identity.** Callers cannot distinguish an exited process from an unavailable observation. The identity API rejects uncertainty independently of the terminal's complete-table guard.

**Use the default timeout signal.** A native helper can ignore `SIGTERM` and keep a synchronous call blocked. `SIGKILL` terminates that helper without treating its exit as evidence about the workload.

## Consequences

Incomplete process observations can delay cleanup; they cannot authorize release or disable later termination. The [PTY ownership decision](../feature/2026-07-16-persistent-pty-sessions.md) and [unattended terminal decision](../feature/2026-09-14-unattended-browser-terminal-reclamation.md) remain active because they own terminal lifetimes and idle policy. This change does not strengthen fallback containment against escaped descendants or make process-table scans atomic.
