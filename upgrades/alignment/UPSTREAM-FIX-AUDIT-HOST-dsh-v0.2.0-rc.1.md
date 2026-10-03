# Host-side upstream bug-fix audit — dsh-v0.2.0-rc.1 (4878cda) vs 内部harness (base alpha.2 ddefc45)

Source: subagent 6bccd4f8. Scope: all 123 COMMIT blocks in fix-host.txt. Read-only.

Verdict counts: port=22 · port-intent=37 · upstream-only-but-map=8 · skip-excluded=13 · skip-n/a=43.

## Confirmed shared defects (direct ports, ranked)

1. **cfa84ed4** `subprocess-local/src/output.ts:108-125` — unguarded openSync/writeSync on spill file kills the whole host. Availability-critical on shared multi-tenant host. PORT.
2. **6a6f350b** agent-loop — `ToolCallRecovery`: never close a failed step with unanswered pending tool calls; append synthetic `tool/result` before failed `step/end`. Port-intent into our agent.ts + repair.ts.
3. **4e6a1c10** `session-query/src/observation.ts:282-293` — live projection failures must classify as `SESSION_QUERY_CORRUPT_SESSION` (try/catch absent, == a2). Direct port.
4. **35f3abf1** agent-loop `agent.ts` — `abortedCancelCause()`: copy only JSON-safe turn/end fields before logging (Node fetch can attach `stack`). Direct port.
5. **7e7ba139** `util/atomic-write/src/index.ts` — stale lock takeover via `process.kill(pid, 0)` + PID-reuse guard; crashed writer currently wedges file until timeout (== a2). Port; note PID-namespace caveat for containers. (Companion 910711e6 joins it.)
6. **dc07e5a5** — `truncateWithoutSplittingSurrogatePair()` for every `slice(0, maxOutputChars)` cap: tool-str-replace-editor + shell persistent tools. Port helper into util + update all cap sites.
7. **a0f59aac** — vendor `patches/@earendil-works__pi-ai@0.85.1.patch` + register in pnpm-workspace.yaml patchedDependencies. O(n²)→O(n) streamed tool-call arg parsing.
8. **9d4fa54c** `tool-bash-persistent` + `tool-pwsh-persistent` — reset shell then return '' instead of `throwIfAborted()` so runtime publishes cancellation status. Direct port both.
9. **76a2b7a7 + 3693c2b4** `terminal/terminal-bash` — `promptTailGraceMs` config + `>= pollIntervalMs` validation + gate on `CONTROLLED_PROMPT.startsWith(promptTail)`. Direct port.
10. **3d5ba3b8 + 36e63275 + d5ad3bae** sandbox — scope parent-delete deny to containers; deny ambient parent-delete inside granted roots; Low-integrity label confinement. Direct ports (sandbox-local == a2).
11. **25e235d2** llm-deepseek — rebuild stale file-mapping index in one update instead of entry-by-entry. Direct port.
12. **193f9ce4** llm-deepseek + session-log-deepseek — drop oversized request extensions rather than stalling request. Direct port.
13. **068c552b** `util/values/src/index.ts:16-38` — WebKit native-constructor text: derive via `Function.prototype.toString.call(...)` instead of literal compare. One-line port.
14. **5992977f** — refresh `patches/@yao-pkg__pkg@6.21.0.patch` to rc1 (atomic SEA addon extraction).
15. **766eee63** `scripts/release/tarball.ts:29-39` — run tar with `cwd: dirname(tarball)` + basename (GNU tar `C:` remote-host bug).
16. **a8950664 / 2b9923fe / 95611fbc / 68e43b17** `util/native-command/path-opener.ts` — Explorer foregrounding, field-separator escaping + non-ASCII literal, comma-safe URI encoding, shell-resolution routing. Direct ports (4 commits, same file).
17. **ad83cce3** session-persistence-jsonl — repair missing `turn/end` during V3 migration; port the rule into our migration pass (our layout differs).
18. **b97ef29e + 3dd52bfd** session-telemetry-otel — await exporter slot cleanup between requests; byte-bounded request scheduling per session. Port-intent into our rewritten package.
19. **d088572e + 6fef0f0a** — persistence `identity: symbol` + session-query cache keying by `persistence.identity` (object-keyed cache destabilizes under service replacement). Two-step port.
20. **97545d9c** — centralize controlled-prompt in terminal-bash; port intent carefully (our fork duplicates PWSH_PROMPT_SETUP in tool-pwsh-persistent — check startup ordering before deleting).

## Upstream-only-but-map (map intent onto our rewritten surfaces)

- **ffea3c88 + 4cfd292a** gateway — uplink lifecycle completeness + bounded stream-cancellation retention → map onto `api/gateway/src/client/remote-stream.ts` + `typert/protocol` (ours uses RemoteStream + generation abort, not LogicalStream). Verify our cancel registry is bounded.
- **c4d40864 / 9ff8f264 / 1b51a1ad / 55d57d33** session-controller projection lanes → map onto `host/apiproxy` + `client/connection` ordering model. (55d57d33 blankness likely already absorbed — verify retained-metadata init parity in api/sessions.ts.)
- **0c44e546** attachment discovery restricted to declared event content → map onto `host/apiproxy/src/api/` duck-typed scan (~:463-511).
- **8e5866e7** — verify our model discovery retains API-key provider catalog when no credentials configured (upstream solved via api-key package split).
- **931505a9** — `host/apiproxy/src/workspace-files.ts` list dir links by resolved target.

## Port-intent onto rewritten files (37 total; high-value subset)

- 6f570309 + 2152881f + 7252e582 app-boot resolver — interception-layer model vs our fallback-route model; routed errors must keep real importer identity through async native() rejections.
- 1bd3df92 + ccaa0dc1 plugin-manager — bound pnpm process **tree** so silent/zombie child can't hold profile lock (`run-tree.ts` absent locally). High cloud value.
- 07ad7081 — incompatible bundles must fail loud with clarified refusal (bundle gate).
- cf6276e7 — persistence-schema gate: independent per-graph type graphs (verify ours doesn't conflate).
- ec7030af compaction-basic — `maxTokens ?? headroomTokens` cap rule into our rewritten config surface.
- e134ba87 persistence-jsonl — unvalidated row fields formatted explicitly in diagnostics.
- a7725060 fs-local — add parent-watch + readiness before answering "missing" (feature-shaped; our fs-local has no watch).
- de8b10f8 browser-use — verify our composition shares installation scope/MCP clients.
- defb9c37 python hatch_build — Windows MAX_PATH-safe bundled resource paths.
- 1b87a2a8 ui-agent-preset — keep Creator entry reachable on preset settings page.
- 02a0c706 ui-deliverables — shared file-diff collection must not drop prior review fixes.
- c6e38b36 client — review-tab conflicts + path-label coverage (map onto ui-workbench/ui-deliverables).
- 1e6630a8 agent-team — mailbox fold must preserve opaque JSON verbatim (our `fold.ts` loosely-typed).
- d6a0e332 llm Files API — malformed JSON → distinct diagnostic class.
- 82c6a5e4 llm — tolerate assistant blocks already in Messages input history.
- 449c6798 test-support/session-snapshot — expand source references before fixture write.
- 507e0e6d agent-team — expose Team targets in status payloads + simplify model-visible statuses.
- 9ae6f0de client — platform-gated `shell.leading` seat + fullscreen relay coverage (check web-shell equivalent).
- a964bd34 tools — native-container field validation at parse boundary.
- 284ab155 ui-sidebar — document preview refinements.
- 0859dca8 ui-chat — completed-turn duration floors at 1s.

## Deliberate-deviation check — CONFIRM WITH OWNER BEFORE PORTING

- **8cf9c0ed** tool-bash — upstream allows blank justification w/o escalation; our fork enforces stricter reject-blank inside sandbox-escalation governance. Likely intentional — do NOT relax without confirmation.
- **b6775f6d + 2d653be7** tool-jobs `index.ts:38-52` — upstream made `maxConsecutiveWakes` optional (unbounded default); ours keeps `3` + WeakMap accounting. Likely deliberate multi-tenant bound — do NOT adopt unbounded without confirmation.

## Skip-excluded (13) / skip-n/a (43) — notable

- b38da295 web-search-deepseek account-token auth — skip (we own auth; provider keeps API-key only).
- 8e5866e7-category session fixes (8de4e518/eafd5b60/1b0c2e57/59318c12) — anchor in rc1-only machinery (ToolCallRecovery tool-history projection) absent locally; revisit only if tool-history ported.
- fa04034a — verifier process isolation superseded at rc1 (file no longer exists); no net fix.
- 7021420f — our `check-workspace-constraints.ts:561-577` already has the workspace: protocol gate.
- 4e6a1c10-category session migration scripts (`migrate-sessions-to-v4*`, cast baselines) — absent locally.
- b0be6e79 PTC image forwarding — no local surface found; route to client-lane audit.
- file-applications native-command fixes ×5 — feature absent locally.
- All CI/workflow/version-metadata/generated-artifact fixes — n/a.
