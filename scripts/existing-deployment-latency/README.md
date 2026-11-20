---
kind: reference
title: Existing QA deployment latency sampling
summary: Opt-in browser measurements against an already running, authorized personal Runtime.
---

# Existing QA deployment latency sampling

English | [中文](README.zh.md)

## Summary

The [entrypoint](../measure-existing-deployment.ts) prints a plan by default. Its explicit `--execute` mode measures hot creation, historical opening and durable text acceptance separately, with 50 attempts of each planned by default. It uses the existing Web UI, a fresh private browser context and the [shared browser launcher](../../apps/web/tests/computer-browser.ts); it does not launch fixture servers, allocate a Runtime or change permissions. The execution path requires real-deployment verification before its timings can be cited; the offline tests prove configuration, planning and receipt accounting only.

## Contents

- [Configuration](#configuration)
- [Invocation and effects](#invocation-and-effects)
- [Reading measurements](#reading-measurements)
- [Dev Note](#dev-note)

<a id="configuration"></a>

## Configuration

Copy [config.example.json](config.example.json) into an owner-private directory, replace every target field, and protect the file with mode `0600`. Use canonical absolute local paths for this file, the cookie and the output; their parent directories must be owner-private. The driver supports POSIX private-file checks. It can measure a Windows Runtime through an existing loopback tunnel, or use a dedicated Windows Chromium through `browser.cdpEndpoint`; it does not create either tunnel. The configured origin must reach the same Gateway from both the driver and browser.

| Fields | Meaning |
| --- | --- |
| `origin`, `platform`, `release` | Existing loopback origin with explicit port, execution-node platform, and operator-verified frozen manifest identifier. The release label is not a server version probe. |
| `accountId`, `nodeId`, `runtimeId`, `workspaceId`, `workspacePath` | Exact authorized personal allocation and existing workspace. No target is inferred from a display name or cookie. |
| `computerName`, `language`, `testModelLabel` | Current node name, effective UI language (`en` or `zh`), and selected controlled-model label. The runner checks this label without changing model settings. |
| `historySessionId`, `historyTitle`, `historyMarker` | A dedicated, idle history already visible in the workspace sidebar. Its title and known visible test marker must begin with `testPrefix`; use a short history so the marker is in the loaded tail. |
| `testPrefix` | `QA_PERF_` followed by 4–56 letters, digits or underscores. Newly confirmed conversations receive this prefix, a run identifier and an ordinal. |
| `authenticationFile`, `outputFile` | A private file containing one existing `cookie_name=value` and a new JSONL receipt path. Existing output files are never replaced. Authentication values do not enter the plan or receipt. |
| `samples`, `timeoutMs`, `settleTimeoutMs`, `intervalMs` | Attempt budget per action, browser/HTTP wait limit, accepted-turn completion limit and pacing between actions. Defaults: 50, 30 seconds, 120 seconds and 1 second. |
| `browser` | Explicit engine; optional installed `executablePath`, or a dedicated loopback Chromium `cdpEndpoint`. CDP and executable path are mutually exclusive. The browser platform is not inferred from `platform`. |

Before execution, the operator verifies that the existing QA model uses an authorized controlled endpoint, returns `CANDIDATE_QA_ACCEPTED` and needs no tools. A matching display label alone does not verify the provider URL. Keep an exclusive measurement window: no service switching, builds, backup load changes or other measurements. A ready-directory check precedes navigation and each iteration and follows every measured operation. It verifies the exact Runtime, personal owner and node; changed ownership rejects the measurement. Requests may omit `dshNode` under the existing protocol, but any supplied node must be unique and match that verified node. Runtime, target kind, principal and versioned response Runtime remain mandatory. These checks are hot-workload preconditions, not locks against somebody stopping or moving the Runtime afterward.

<a id="invocation-and-effects"></a>

## Invocation and effects

From the repository root, the following command reads only the private configuration and prints the intended work. It does not read the cookie, launch a browser, contact the origin or create the receipt file.

```sh
node --import tsx/esm scripts/measure-existing-deployment.ts --config /private/qa/measurement.json
```

After the deployment owner approves that plan and the measurement window, append `--execute`. This authorizes creation, naming and one text prompt in up to `samples` dedicated conversations. Opening uses the configured existing test history. The script does not grant access, change configuration, retry a failed mutation, stop a turn, delete conversations or clean their files. Unknown results and failed operations stop later mutations; retain their operation/Session identifiers for inspection before another run. A create confirmed before a naming failure can leave an unnamed Session whose identifier remains in the receipt.

The runner owns its new browser context and its connection, closes them on completion or interruption, and leaves existing tabs alone. A private exclusive lock beside the cookie prevents another invocation using that same directory and Runtime. A crash can leave the lock; verify its recorded process is gone before manually removing it. The lock does not exclude another computer or another credential directory. Only use CDP with a browser dedicated to this run.

Setup explicitly expands the configured computer and workspace, selects the exact history row and waits for its known marker before measuring. Before initial selection and every historical open, the runner reveals the exact row through that workspace’s session expansion and that Runtime’s directory paging controls, then scrolls it into view. Row discovery shares one `timeoutMs` deadline and finishes before click clocks are armed; its scrolling, paging and actionability checks are excluded from `readyMs` and `driverMs`. A discovery failure during a sampled open remains a failed attempt and stops further sampling. It does not seed browser selection storage. The owned context supplies the function-name helper required by `tsx`-serialized browser callbacks. Failures record their setup or operation stage, DOM counts and resource IDs, and bounded request-routing metadata without message content. Guard refusal codes take precedence over the response wait timeout caused by an aborted request.

<a id="reading-measurements"></a>

## Reading measurements

The output is append-only JSONL: one plan, one raw receipt per attempted action, then a summary. It contains identifiers, safe result codes and timings, not messages, workspace paths, cookies or response bodies. Each action reports expected, attempted, successful, failed, timed-out and not-run counts, failure rate, and nearest-rank P50/P95. Missing values are null; unattempted work is never counted as success. An accepted prompt whose model fails to settle remains a successful durable receipt with a separate completion failure; further samples stop.

A durable receipt requires the versioned admission endpoint, the exact Session and application request ID, a matching RPC response ID and a positive result. The Host forces `durable: true` for this endpoint; ordinary `/api/session.prompt` acceptance, HTTP 200, UI echo and model output are insufficient. A recovery status must refer to the same original request.

Naming is outside the measured operation. Its ordinary RPC route confirms the matching request ID, exact synthetic title and title-event sequence; only the versioned preparation/admission routes require the Runtime response header. Runtime-directory reads stop and cancel after one MiB of response bytes.

| Endpoint | What it measures |
| --- | --- |
| `editableMs` | Browser click event to the editable preparation view for the exact Runtime. |
| `readyMs` | Browser click to ready creation UI, or the authorized history view containing the known marker. |
| `durableReceiptMs` | Browser Enter event to receipt of a positive durable prompt/status response from the owner. This includes transport; it is not a server-only commit duration. |
| `firstVisibleAnswerMs`, `completionMs` | Browser Enter to visible assistant response text and settled controlled reply. Neither is the model server's first-token timestamp. |
| `driverMs` | Playwright command and waiting time, recorded separately from browser event clocks. |

Quantiles describe successful endpoints; raw failed samples retain any observed editable time. `hostDurationMs`, when present, covers the Host RPC, not just database persistence. Server commit and model first-token timestamps are explicitly unobserved. Resource telemetry points are not operation samples. Compare the same release manifest, account/grants, selected model, data, browser placement, network and load; a local synthetic 500 ms fixture is not a deployed Mac or Windows result.

<a id="dev-note"></a>

## Dev Note

[Offline tests](config.spec.ts) cover private input, opt-in execution, exact identities and statistics. [The synthetic browser test](../../apps/web/tests/personal-runtime-latency.e2e.ts) shares the click clock but owns separate servers and data. The [admission decision](../../.agents/notes/implemented/architecture/2026-11-04-node-qualified-conversation-admission.md) explains durable acceptance and identity preservation. Neither test substitutes for executing this entrypoint against a reviewed QA deployment.

The [sampling decision](../../.agents/notes/implemented/testing/2026-11-17-existing-deployment-latency-sampling.md) records why deployed measurements remain separate from synthetic regression fixtures.
