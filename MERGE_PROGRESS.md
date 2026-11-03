# Merge progress (codex/business-logic-audit-2026-10-23 -> master)

## State: all conflict markers resolved; fixing compile errors from mangled merges.

Done:
- All 203 conflict files resolved & staged. `git diff --cached --check` clean.
- pnpm-lock.yaml regenerated via `pnpm install --lockfile-only`. `pnpm install` done in this worktree.
- Regenerated: config-catalog, client slot-catalog, session-format generated.ts,
  tool-catalog.md, persistence catalogs, THIRD_PARTY_NOTICES.
- `resolve-translation-pairing-conflicts`: "no unresolved pairing records" (already clean).
- terminal-controller model.ts: removed mangled dual pendingInput impls (kept theirs' simple input).
- Deeply interleaved JSX/logic files restored wholesale from MERGE_HEAD (git show MERGE_HEAD:file):
  ui-collaboration ScopeControl.tsx + ProjectManagerModal.tsx, ui-workspace WorkspaceBrowser.tsx,
  ui-documents DocumentsModal.tsx + DocumentsButton.tsx, ui-workbench apply.ts + WorkbenchToolbar.tsx
  + WorkbenchPaneHeader.tsx, ui-conversation ConversationRoot.tsx, ui-schedule TaskManagerPage.tsx,
  ui-workspace tree.ts.
- Hand-merges kept: gateway-runtime index.ts (streamPrincipals + resourceBudget both),
  proxy.ts/runtime-api.ts (renewal + node-service/doc-store), connection index.ts
  (documentIdentity + rpcTimeoutMs + fence search arg), ui-collaboration index.ts
  (will-reset + loadEnvironments), ui-workbench apply.ts reloadResource -> boolean,
  ui-settings-plugins webSearch?., fixture options union (runtime+projectId+renewal+onEvent).
- ui-workspace stores.ts: ADDED syncSessionOrderAccount (singular) action delegating same
  write as plural syncSessionOrderAccounts — WorkspaceBrowser (theirs) calls singular.
- ui-documents index.ts: footer.action register needs `inject: injected`;
  DocumentsOverlayProps -> InjectFace<DocumentsButtonInjected>. locales scope.search dup
  resolved to theirs ('space or computer').
- ui-documents e2e: restored assertTooltipInsideManager fn (HEAD) used by kept call site.
- user-terminal.e2e: renamed queued-test counter inputRequests->queuedRequests (collision).
- project-activity.e2e: added `import { join }`.
- workspace-office.e2e: dropped unused pdfResourceFixture import.
- gen-cordis-catalog.ts: removed dup object keys (resourceBudget@99, Parsed*/PluginConfig*@899-901).

In progress — `pnpm run typecheck` still failing, remaining errors (as of last run):
- packages/client/connection/tests/client-apply.client.spec.ts: missing `})` before
  top-level `it('opens an explicit personal carrier'...)` at ~line 886 (describe close lost).
  Orphan `it` at TOP LEVEL is correct in BOTH parents — the describe above needs its `})`.
- packages/client/ui-collaboration/tests/plugin.client.spec.ts: same pattern — `})` deleted at ~357
  may have been wrong direction; top-level its exist in parents too — re-check (I removed a `})`
  at 357 and appended `})` at EOF; verify balance.
- packages/client/ui-documents/tests/components.client.spec.tsx: same — removed `})` at 2656
  + appended EOF `})`; verify.
- packages/test-support/client-runtime/tests/assembly-bundle-roster.client.spec.ts: same
  (removed @327 + appended EOF); verify.
- packages/client/ui-collaboration/src/client/locales.ts: dup keys at ~126,228,419,521
  (zh+en pairs from 'both' merges) — pick current-side value like ui-documents did.
- packages/client/runtime/src/client/index.ts(416): handleConnected() returns void in theirs'
  service but index.ts expects Promise<WorkspaceArchiveSnapshot|undefined>; handleDisconnected
  missing on WorkspaceRuntime — the runtime service.ts was taken theirs but index.ts uses HEAD API.
  CHECK HEAD service.ts handleConnected/handleDisconnected vs theirs and reconcile signatures.
- packages/client/runtime/src/client/sessions/pool.ts(311): 'baseline' unused + SessionListState
  missing state,error props (theirs' snapshot dropped HEAD's baseline fields — need union fields).
- packages/client/ui-conversation ConversationRoot.tsx(565): onViewportEnabled missing on
  ConversationSlotProps (props type from HEAD side lacks it — file is theirs; check HEAD props).

Then: rerun typecheck -> lint -> targeted tests -> commit merge -> push + PR.

=== STATUS UPDATE (post typecheck-green) ===
typecheck: PASS. All conflict markers resolved; pnpm-lock regenerated.
Generated artifacts: translation-pairing script run; THIRD_PARTY_NOTICES pending confirm.

Test fixes applied since typecheck green (all verified green):
- ui-collaboration 147/147 (ScopeControl spec->MERGE_HEAD page-structure, dual-scope
  readInvitations union contract, manager.retry key, select->Menu adapter, initialConnection
  union param, per-path fetch counting).
- ui-documents 211/211 (reopen->ROOT_DIRECTORY_ID, select-mode attach keeps callback for
  preflight alert, returnFromTrash mechanism restored, restore invalidates directory cache,
  upload feedback view ported, renderPickerButton restored, canAttachDocument->true when
  method absent, button no longer self-hosts modal).
- ui-conversation orchestration 25/25 (audit unconditional retirement restored; drafts
  release only on observed admission; sessionPersistenceKey-scoped draft keys; specs
  clear sessionStorage).
- workbench-runtime-ownership 8/8 (fake transport pumps mux stream; echo frames reach
  project runtime via real pool path).
- runtime session-pool-archive 10/10 (stale aborted inflight treated as dead -> fresh
  workspace.list; test fixture replays connect to newly started sinks).
- runtime client-apply 16/16 (selectionPersistenceKey honored; legacy unscoped key untouched).
- ui-workbench apply+assembly 50/50 (selectPanel(null)+focusPane restored on conversation
  nav/exit/openResource).
- userdoc-upload 20/20 (first verification read BEFORE deadline check; deadline stays
  min(expiresAt, now+MAX); union of HEAD+audit semantics).
- ui-workspace browser 78/78 incl. workbench-hidden search abort (workbenchMode early-return
  + dep restored in search effect).
- ui-settings-general shell: remote stub now provides $forTarget()->$on.

Deleted: packages/client/runtime/tests/zz-debug.spec.ts (temporary debug spec).

Remaining: full `npx vitest run packages/client` re-run in progress to confirm 0 failures.
Then: pnpm-lock regen confirm, translation-pairing/THIRD_PARTY_NOTICES regen confirm,
git diff --cached --check, commit merge, push sync branch, PRs.
