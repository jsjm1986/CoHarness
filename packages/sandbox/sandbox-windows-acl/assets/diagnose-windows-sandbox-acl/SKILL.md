---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read. One bundled command inspects the path and every ancestor and repairs the ACL problems it proves in that same run. Expected confinement denials need no ACL repair.'
---

# Diagnose Windows sandbox ACL failures

**Write every approval request in plain words, in the user's language.** The approval prompt is all the user reads before widening access, so it must stand alone: which folder the script touches, that it adds the signed-in user's full-control entry where a right is missing and removes foreign package entries, that file contents and owners are unchanged, and that each change can be undone with the printed recovery command. Keep error codes, `WRITE_DAC`/`WRITE_OWNER`, `S-1-15-2-*` SIDs, `icacls`, verdict names and switches out of the request; they belong in the report. Ask once, for one command.

## One command diagnoses and repairs

The script has no modes. `-Path`, `-AllowRoot` and `-Out` read the path and every ancestor and repair what the observations prove, in the same run:

- directories on that chain that lack effective `WRITE_DAC` or `WRITE_OWNER` receive a full-control allow ACE for the signed-in user, because DSH cannot provision its workspace grant without them;
- explicit AppContainer package allow ACEs (`S-1-15-2-*`, except the well-known groups ending in 1 or 2) are removed at their sources, ancestor first, which also removes those packages' access;
- when the requested directory is one the sandbox cannot provision — the state its provisioning error reports on the workspace root — or it is the authorized root, explicit package allow ACEs under it are collected in the same run, so a deeper conflicting entry needs no second request. That bounded walk reports `truncated` and unreadable directories; if truncated, pass the still-failing deeper path once more.

Every change is backed up first and verified by re-reading it. `-AllowRoot` bounds all of it: an object is changed only when it is that directory or strictly inside it, so a workspace root can repair itself. Never split this into a diagnostic call and a repair call, never ask twice for one repair, and never pass a mode switch that does not exist.

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -AllowRoot '<authorized-directory>' -Out '<recovery-directory>'
exit $LASTEXITCODE
```

Substitute full, quoted paths. Keep `-Out` persistent and user-owned, preferably beside the failing workspace inside `-AllowRoot`; never use the skill resource directory, which is deleted when the skill unloads. Pass one path per invocation; do not repeat `-Path` or pass a comma-separated string to `pwsh -File`.

## Decide whether diagnosis applies

Diagnose an unexpected denial of workspace writes, listing, or reads the signed-in user should plainly have. Root-only failure and uniform failure are both eligible. Stop and explain expected denials instead: writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, or ConstrainedLanguage errors for .NET/COM/reflection.

## Run it

1. Repeat the failing operation once in the current sandbox. If it succeeds, there is nothing to repair.
2. If it fails, run the command above confined once, if the sandbox starts at all. A writable `-Out` is enough; `read-only` refuses one.
3. When sandbox setup itself fails — the error names the workspace root or `SetNamedSecurityInfoW` — every confined call fails before your command runs, so do not retry confined. Request approval for that one command and run it unconfined. Unconfined does not elevate the Windows token.
4. If approval is refused, unavailable, or forbidden by policy, report the path as undiagnosed and stop.

## Read the output

The script prints a `REPORT` record for every observation, decision, action, verification and recovery, then a final `RECAP` line, the report path and `SUMMARY FIXED=<n> GRANTED=<n> REFUSED=<n> RESTORED=<n>`. Tool output keeps only its tail, so read the `RECAP` line: it carries the verdicts, changes, verifications, refusals and scans. The complete record set is in the `acl-report-*.jsonl` file whose path the run prints; read specific records when the recap is not enough, and quote what you rely on.

Trust the `verification` records; `completed` actions only confirm API execution. Decide from `details.nextAction`:

| `nextAction` | Meaning |
|---|---|
| `verify_original_confined_operation` | Repairs verified; repeat the original operation confined. |
| `stop` | Nothing was repaired, or a refusal ended the run. Report and stop. |
| `restore_pending_then_stop` | Rollback was not verified. Run the printed recovery commands in order, then stop. |

A deny ACE's presence alone does not establish causation; the script never removes one. DSH provisions `S-1-4-*` grants and an Everyone `DeleteSubdirectoriesAndFiles` deny: both are expected, not conflicts. A deny that blocks the repair ends the run without a repair — `REPAIR_REFUSED`, or `GRANT_FAILED` — and the script then restores what it attempted. Each change leaves two files in `-Out` (`acl-backup-<id>.json` and its `.ps1`), and the run prints the matching `ROLLBACK` command.

## After a repair

Repeat the original failed operation in the original confined context. A repair that verified is not undone because the original operation fails for a further reason: continue from the new observations. If a deeper path is still denied, run the same one command on that path — again one call, one approval.

**Stop after any failed or refused repair, or any failed verification.** The script already restored that invocation's attempted changes; do not repeat it or continue to another repair. Restore earlier successful invocations in reverse order with their printed commands, then report.

**When the run stops, hand the user a decision, not silence.** Say which object and which ACE or missing right still blocks the operation, what was changed and rolled back, the recovery commands in order, and the report path. Unblock the user by switching this session to full access temporarily: say that confinement is off for it and that this is a workaround, not a repair. Then ask the user to send feedback with this session so the unhandled scenario reaches us; only what reaches this conversation travels with it, so read the report and quote what matters.

## Never

- edit ACLs by hand, change an owner, erase a deny, or replace child permissions recursively;
- run the script elevated, through UAC or `runas`; it and its recovery copies are user-writable;
- widen `-AllowRoot` to reach an ancestor, or repeat a denied or failed call.

Report in the user's language: analyzed paths, changes and why, verification, recovery commands, next step. Label an authorized unconfined run as such, not as a sandbox repair.
