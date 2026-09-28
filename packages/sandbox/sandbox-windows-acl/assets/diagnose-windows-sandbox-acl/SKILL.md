---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read. The bundled script inspects the path and every ancestor, reports observations and action reasons, and supports scoped, backed-up ACL repairs. Expected confinement denials need no ACL repair.'
---

# Diagnose Windows sandbox ACL failures

**Stop after any failed/refused repair or failed verification.** A completed DACL write is not a successful repair. Never continue from a failed grant to `-Fix`, repeat the grant, or remove a deny ACE. The script automatically restores attempted changes from the failed invocation; verify its rollback result. Restore earlier successful invocations in reverse order using their exact recovery commands, then stop. A repair that verified is not reverted because the original operation failed for a further reason: continue from the new observations instead.

## Decide whether diagnosis applies

Diagnose unexpected denial of workspace writes, listing, or reads the signed-in user should plainly have. Root-only failure and uniform failure are both eligible.

Stop and explain expected denials: writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, or ConstrainedLanguage errors for .NET/COM/reflection. Request an approval for the one call you still need; do not repair ACLs for these cases.

## Read the report before choosing a repair

Resolve the script from this skill's resource directory. Run it in the current sandbox first: classification completes under `workspace-write` with a writable `-Out`; `read-only` refuses one. When a denial or an unwritable report directory prevents the call, request one escalation of that same call through the normal approval path instead of assuming it cannot run, and let that one call both diagnose and repair: run the script with `-Compact`, then re-run it with `-GrantFullControl` and, when the verdict names package ACEs, `-Fix`. The script skips a grant it does not need and refuses an unsafe one, so one approval covers both; if approval is refused, unavailable to the session, or forbidden by policy, report the path as undiagnosed and stop. Unconfined does not elevate the Windows token. Use one path per invocation; do not repeat `-Path` or pass a comma-separated string to `pwsh -File`.

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -Out '<report-directory>' -Compact
exit $LASTEXITCODE
```

Substitute full, quoted paths. Choose a persistent, user-owned `-Out` directory, preferably beside the failing workspace within the authorized tree. Never use the skill resource directory: it is deleted when the skill unloads. `-Compact` saves a unique full JSONL report and prints one `REPORT` summary. The summary lists every inspected path, finding, decision, ACL action, verification, rollback state and `nextAction`. Decide from the summary; read specific records only when evidence is missing, not the implementation.

Each full record has `kind`, `operation`, `path`, `status`, `reason`, `details`. Unknown observations remain unknown. A deny ACE's presence alone does not establish causation. DSH provisions `S-1-4-*` grants and an Everyone `DeleteSubdirectoriesAndFiles` deny; both are expected, not package conflicts. Coexisting package ACEs may still block the confined child even when provisioning fails first; do not dismiss either finding. `completed` actions only confirm API execution. Check verification: a missing summary means unconfirmed completion, so inspect the report and recovery artifacts first.

| Verdict | Next step, only with complete observations |
|---|---|
| `CULPRIT` | Explain the affected paths and individual package allow SIDs; select `-Fix`. |
| `PRECONDITION` | Explain missing effective `WRITE_DAC`/`WRITE_OWNER`; select `-GrantFullControl` if the caller has `WRITE_DAC`. |
| `BOTH` | Grant on the affected object first. Only after verified success may a separate invocation use `-Fix`. Failure ends this sequence. |
| `UNREADABLE`, `INCOMPLETE`, `NOT_THIS_CLASS` | Report observations and stop; do not infer a safe repair. |

## Run the selected repair

Explain the finding and cost first. `-Fix` removes individual `S-1-15-2-*` allow ACEs at their explicit sources, ancestor first, then verifies inherited entries disappeared; well-known groups ending in 1 or 2 are preserved. Never grant or repair a purely inherited copy: repair the explicit source, then re-read the child. This removes those packages' access. `-GrantFullControl` adds a current-user allow ACE; it cannot cancel an explicit deny. Both preserve owner, inheritance and SACL, including Low integrity labels. Low executable labels and their effects outside DSH are outside this repair's scope. Full control supplies `WRITE_DAC` and `WRITE_OWNER`; taking ownership alone does not.

Append `-AllowRoot '<authorized-containing-directory>'` and **exactly one** of `-Fix` or `-GrantFullControl` to the diagnostic command, before `exit`. Keep `-Compact -Out`. Every explicit source must be strictly inside that root, except that `-GrantFullControl` accepts the affected object itself so a caller can repair its own workspace root; `-Fix` still needs a strictly containing root. Reparse paths and managed application trees (`LocalAppData\Packages`, `ProgramFiles\WindowsApps`) are refused. Never widen the authorized root to reach an ancestor. Missing effective `WRITE_DAC` in the unconfined caller requires stopping and reporting the path and missing rights for permission-policy review. Extracted scripts and recovery copies are user-writable: never supply commands to run them elevated or initiate UAC/`runas`.

Follow `nextAction`: `stop` ends repairs; `restore_pending_then_stop` requires the reported recovery commands in their listed order, then stop. Verified rollback does not turn a failed repair into success. Keep full report/backup paths and exact recovery commands for every invocation; never abbreviate executable paths. On recovery failure, stop and report the remaining commands without more repairs.

For `verify_original_confined_operation`, repeat the original failed operation confined. A new observation continues the diagnosis; only a repair that failed its own verification restores this workflow's successful repairs in reverse order and stops. Do not start another repair cycle.

Use the user's language for progress and final reporting. Concisely report observations and analyzed paths (including relevant ancestors), actions and reasons, verification, and the next step; link full reports. Label any authorized unconfined fallback as such, not as successful repair. Never write probe files, edit ACLs by hand, change owners, erase denies, or replace child permissions recursively. Do not provide manual ACL-edit commands for the user either: only bundled repairs and generated recovery commands are supported; unresolved denies require permission-policy review or moving the workspace. Request each approval in plain words: the folder, what you will do, why it needs wider access, what stays unchanged. Keep the tool's error text, API names, SIDs and repair switches in the report. State the full plan before the first request, and never repeat a denied call.
