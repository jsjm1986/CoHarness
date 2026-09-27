# Acceptance runbook — dsh-v0.1.6-alpha.2 alignment

English | [中文](ACCEPTANCE-RUNBOOK.zh.md)

Executable acceptance protocol for every item the alignment audit cannot close inside the repository. Each item lists preconditions, steps, pass criteria, and the evidence to record back into [UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md](UPSTREAM-AUDIT-dsh-v0.1.6-alpha.2.md). Check items off by editing this file in place; record evidence inline under each item's Evidence table.

Status legend: `open` → not started · `in progress` → evidence being collected · `done` → pass criteria met with recorded evidence.

## 8-f — Real dual-user acceptance (LAN/public)

**Ledger rows:** L8, L9 (partial), release-freeze removal.
**Status:** `open` · **Owner:** release executor + two distinct users on separate machines.

### Preconditions

- Packed release candidate installed from tarball (`pnpm run release:pack` output), not a source checkout.
- A shared Gateway deployment reachable by both users, or two machines on one LAN running independent sessions.
- `DEEPSEEK_API_KEY` available on each participant's host.

### Steps

1. User A installs the packed artifact, starts the web client, creates a session, sends a prompt, and runs a tool-bearing turn (file read + shell command) to completion.
2. User B repeats step 1 against the same deployment (or the shared project runtime), including a second session in the same Workspace.
3. Both users exercise: session resume after client reload, model selection switch mid-session, one permission prompt, and the document/attachment insert path.
4. Optional Gateway path: share one project conversation; verify participant attribution renders for the other user.

### Pass criteria

- No crash, no stuck turn, no error without a readable diagnostic line; both users' sessions persist and resume correctly.
- Tool calls render results; permission prompts resolve through the UI; Workspace state survives reload.

### Evidence

| Field | Value |
|---|---|
| Date / build | |
| User A env (OS, Node, install mode) | |
| User B env (OS, Node, install mode) | |
| Deployment (local LAN / Gateway) | |
| Issues found + resolution | |
| Sign-off A / B | |

## Release-freeze removal

**Ledger rows:** 8-f gate, frozen release marker.
**Status:** `open` · **Owner:** repository owner. **Blocked by:** 8-f `done`.

### Steps

1. Confirm the 8-f evidence table above is complete with two sign-offs.
2. Remove the release-freeze marker agreed at upgrade start (version tag, branch protection, or the recorded freeze note — whichever mechanism was used).
3. Record the unfreeze action and its commit/PR in the audit ledger.

### Evidence

| Field | Value |
|---|---|
| Unfreeze commit / PR | |
| 8-f evidence link | |

## L18 — CI platform matrix

**Ledger rows:** L18, L5 (remainder), `--omit=optional` leg.
**Status:** `open` · **Owner:** CI. **Obtained by:** pushing the alignment branch and reading the workflow run.

### Steps

1. Push the review series (or the merge branch) to GitHub.
2. Wait for the platform matrix jobs: Linux, Windows, macOS runners; the `--omit=optional` install leg; windows-wine (if scheduled).
3. On a red leg, fix forward or record a justified platform exclusion in the audit ledger.

### Pass criteria

- Every required matrix leg green on the alignment head commit, or each failure recorded with cause and decision.

### Evidence

| Field | Value |
|---|---|
| Workflow run URL | |
| Head commit | |
| Leg results (per OS / install mode) | |
| Failures + disposition | |

## L9 — Production consistent backup / restore drill

**Ledger rows:** L9 (remainder — migration rehearsal and release closure are already green).
**Status:** `open` · **Owner:** release executor with production-like data.

### Steps

1. Take a consistent backup of a production-shaped data root (session JSONL + SQLite stores + settings) while writes are in flight or quiesced per the deployment procedure.
2. Restore into a clean host; run the packed artifact against the restored root.
3. Verify: sessions list and resume, event counts match the backup manifest, SQLite `SCHEMA_VERSION` monotonicity preserved, no generation files lost (immutable-generation rule).

### Pass criteria

- Restored runtime serves the same session set with identical durable data; no format downgrade or regeneration.

### Evidence

| Field | Value |
|---|---|
| Backup method + size | |
| Restore host env | |
| Session/event counts before ↔ after | |
| Issues found + resolution | |

## L4 — Python SDK platform artifacts

**Ledger rows:** L4.
**Status:** `open` · **Owner:** CI or executor on Linux and Windows hosts.

### Steps

1. Build the Python SDK artifacts on Linux and Windows (the same build entry as the verified macOS arm64 carrier).
2. Install each artifact on its host and run the bundled-runtime smoke: spawn the runtime, open one session, run one tool turn.
3. Record per-platform artifact checksums.

### Pass criteria

- Linux and Windows artifacts build, install, and pass the same smoke the macOS arm64 carrier passed.

### Evidence

| Field | Value |
|---|---|
| Linux artifact + checksum + smoke result | |
| Windows artifact + checksum + smoke result | |

## L7 — Desktop capability acceptance (computer-use / browser-use)

**Ledger rows:** L7, Q4 (Office WASM Linux acceptance environment).
**Status:** `open` · **Owner:** executor on a GUI host with desktop permissions.

### Steps

1. On a desktop host (macOS or Windows with screen/accessibility permissions granted), run the computer-use capability against a real application window.
2. Run browser-use against a real browser session; verify screenshots, input injection, and bounded output reach the model.
3. For Q4: run the Office WASM path on a Linux acceptance host, or record the environment as unavailable and keep Q4 marked unverified.

### Pass criteria

- Capabilities execute against real GUI targets without permission or transport failures; any unverified environment is recorded, not silently dropped.

### Evidence

| Field | Value |
|---|---|
| Host env + permissions granted | |
| computer-use result | |
| browser-use result | |
| Q4 Linux WASM env (verified / unavailable) | |

## Closure rule

An item becomes `done` only with its Evidence table filled and the audit ledger row updated in the same edit. Release completion requires every row `done` or explicitly waived with a recorded rationale.
