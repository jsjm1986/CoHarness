# Client-side upstream bug-fix audit — dsh-v0.2.0-rc.1 (4878cda) vs 内部harness (base alpha.2 ddefc45)

Source: subagent 76427a86. Corpus: fix-client.txt — 454 commit blocks, all enumerated. Read-only.

Verdict counts: port=76 · port-intent=161 · upstream-only-but-map=33 · skip-excluded=167 · skip-n/a=17. Total 454 ✓.

## Classification policy

- port — local file exists at same/adjacent path; CSS/locale/small-component level.
- port-intent — relevant to cloud web product but local surface rewritten; apply intent.
- upstream-only-but-map — upstream impl absent but behavior maps onto named local equivalent.
- skip-excluded — desktop/account/voice/shortcuts/telemetry/packaging lanes.
- skip-n/a — no cloud-web equivalent (CLI-only, absent bundles, version pinning, CI mechanics).

## Confirmed architectural mappings

| Upstream | Local equivalent |
|---|---|
| client/ui-chat/** | client/ui-conversation/src/client/chat/** (ChatView.tsx, use-chat-scroll.ts, step-process.ts, turn-trigger.ts, TurnNavigator.tsx, TurnTailNodeView.tsx, chat-settings.ts, TranscriptViewRow.tsx, transcript-view.ts) |
| ui-sidebar-documentpreview/** | client/ui-workbench/** (workspace/previews/*, pdf/*, office/FontNotice.tsx, office/locales.ts, WorkspaceDocumentPreview.tsx, MarkdownBody.tsx); xlsx preview absent → document/office-to-pdf |
| ui-sidebar-files/**, api/workspace-files | ui-workbench WorkspaceFileBrowser.tsx + host/apiproxy/src/workspace-files.ts, workspace-changes.ts |
| api/session-controller/** | client/runtime/src/sessions/** (manager.ts, service.ts, session.ts, history.ts, conversation-read.ts, running-sessions.ts, session-events.ts) + api/remotes |
| api/workspace-controller, client/store | client/runtime/src/workspaces/** + workspace/workspace |
| api/settings-controller, settings/settings | client/ui-settings/** + fork-owned settings.yaml pipeline |
| client/file-upload | client/ui-attachment/userdoc-upload + host upload |
| cordis-client-runner, tool-cordis, host-cordis | exist locally |
| auto-review, tool-agent-team, client-ui-agent-team, agent-team(-web)-profile | exist locally |

## TOP-10 for the cloud web product

1. **5c8933fb** acquire blank Session writers before reuse — blank-writer reuse race → session corruption; `client/runtime/src/sessions/manager.ts` + api/remotes; analogous harness `cold-blank-session.e2e`.
2. **a44ced5b** gate Remote WebSockets on gateway readiness + **355df025** gateway uplink lifecycle hardening — api/gateway; hits every remote tenant.
3. **820824ed** input echo admission on queued turns + **08c0e8e7** steering dedupe + **5d62f82b** cross-client pending order + **809e0942** retire steering echoes — runtime sessions + ui-conversation queue; transcript corruption class.
4. **50ba2c8b** history pagination on turn boundaries — runtime sessions/history.ts.
5. **fa2abdd6** stale blank-session hints + **e3f0d3fb** session engagement off blank refreshes — session-list integrity on reconnect.
6. **1b55f5be** preparing-tools ordering + **b66b602c** preparing lifecycle + **50b7dd21** process-update isolation/lifecycle details — ui-conversation assembler/chat.
7. **f938ebad** recover lost plugin installation responses — boot/plugin-manager + ui-plugin-manager manager-store.
8. **29182514** resolve feature routes from document dir + gate browser routes — route-gating; host/open-in-app, ui-deliverables present-open, userdoc-upload.
9. **e44efede** corrupt compressed headers off resume path + catalog cluster a978ad19/f9846839/17a52a8f/f44b78a6/a9985b49/86ca9de0 — session-format/projection resilience (immutable JSONL shared).
10. **555b664b/b02b20d7/0fadb08f** compaction headroom cluster — compaction-basic; prompt-cap overruns break cloud sessions.

## apps/web standalone checklist

- Exists locally (port/port-intent): scaffold.ts, steering/settings-chrome/subagent-conversation/tool-details/workspace-management/queue-actions/live-interactions/chat-scroll-contract/goal-bar/goal-multi-turn-actions/ptc-round/markdown-images/plugin-config/seeded-history/replay-round-trip/onboarding-deepseek-config/agent-preset-*/models-settings*/details-session-lifecycle/workspace-office/client-plugin-live/reasoning-preview e2e, auto-review-{denial,fixture}, preset-migration.snapshot, minimal-preset.snapshot.
- Absent → map: document-preview.e2e→workspace-office+ui-workbench; plugin-manager/plugin-install-*→plugin-administration/plugin-config/client-plugin-live; assembled-remote→assembled-boot fixture; blank-writer-reuse/new-session-refused/idle-submission-handoff→cold-blank-session/navigation-*; changed-files-turn/present*/sidebar-right/sidebar-title-hover-scroll/step-process/turn-tail-actions/focus-rings/sessionless-header/link-preview-parser/workspace-new-session-folding→diff-context/produced-files/navigation-panes/rail-search-expand/cold-blank-session/markdown-images.
- Excluded/no equivalent: caption-overlays, composer-shortcuts, voice-*, bonus-notice, desktop-onboarding, onboarding-native, excel-opc, code-card-layout, code-language.snapshot, favicon.spec, desktop-boot.spec, server-restart.
- favicon: upstream src/favicon.ts absent → apply via apps/web/index.html + public/favicon*.svg (exist).

## Caveats / owner actions

- No repo changes made (read-only).
- port vs port-intent conservative: primary surface ui-chat/session-controller/workspace-controller/documentpreview/sidebar-files → port-intent even when local equivalents exist (rewritten).
- **Developer-tools cluster needs fork policy decision** (93caf245 default-on, c7c900a9, a026ab13, 012f993e, caaaf89b, 4f0ee6b1, 1103c1a7 rename to code-work tools, 5577beca clear staged preset on disable) — upstream default may not be our product policy.
- Spreadsheet/XLSX preview fixes: no local renderer (office-to-pdf pipeline); decide keep-ignoring vs add workspace-office.e2e coverage.
- port rows warrant a final diff-level check before applying (audit used subject+paths+local surface, not git show).

## Full ledger

See fix-client.txt for commit blocks; verdicts keyed by SHA above in the agent report (archived in session transcript). Key clusters beyond TOP-10:

- ui-conversation/chat scroll+turn-rail cluster: 43a8a228, 838eff14, 2251b618, 13dfae20, fb02779a, 633cf739, 6b4055bf, 072ea695, 6f66437d, d53c3052, c7b9c914, 9ad25a6a, 3b4ecc9d, daa23875, 92101e1a.
- ui-deliverables/review cluster: fd784e44, 795e5024, 60cdd547, c84c9086, b5cbcad8, a4493ceb, 440070e4, 8f2a1835, 22338595, 63c1e04b, 2e55564e, 28fbe743.
- ui-workspace cluster: aaf733c1, 4db234b4, c4949c4d, 4517603c, 7baccf5d, 1d221f97, 9ca19474, bd0461c8, 3e96ed79, c7e6e36d, 93ad804b, a7ce6954, 1e48dae2, e8f3d02d, 280048d8, ff1c7d41, ce5ef7a1, be5a84ad.
- ui-primitives polish cluster: 9e8db21d, f1142335, e39b0c30, bd2a49a2, bca9cecc, 50f7bc0b, 5467209f, 9a74ba5d, 9e7350bb, db929701, 08b310b5, c7a4fae8, d620c1e4, 31f6c3f1, f1e06a69, 5474efe8, 45d77b0e.
- plugin-manager UI cluster: adb58a76, 473fd151, 0b325601, 142b6552, 69b55fb5, eb9efc62, f057cc37, 5d72bfbe, 16af6fdd, 16c30ed6, f64c57db, 5b4be3cf, a56e82e5, 61b099b7, 75b20ea9, 998d2ce8, 78522443, c34e33cb, 2b168ce1, e303efe0, a6267c8d, 736730c3, 66c1c5fa, 76fa3860, bb2326f0, 3014457c, c85e1d7b, 63190fc8, ef516f98, 0edfe835, 8cf07ea7, f938ebad, cb275001.
- agent-team cluster: f5460685, 3bf6d738, 2aa3a469, 9095678c, a79e3a2a, d257fa4a, 6ec97fa1, 700b6365, 749f05e9, 843e1b97, d08aac9d, 3324157b, 35489c0f, 253fb5e6, 2ea75396, 2b44a4b6, 9f21d784, 507e0e6d(host).
- ui-settings-models cluster: 4374c204, cd57af49, 441939ea, 11c05112, 4cc76d04, d183c8a8, 7b86b84c, dc374b88, b34b5d33, 5124a2a3, d55f434c, 06ef26a8, 66136602, 7d06fcdc, 536a94b1, 98c083bb, ddf11a4f.
- boot/app-boot cluster: c10a8a16, 747c98b0, cf41c158, c9d4b756, 02fec320, 518c7a60, 6d8aac06, a05f2244, de662ee0 (+ host-lane 6f570309/2152881f/7252e582).
- connection/transport: a44ced5b, 355df025, 2aac7c8e, 285f0a70.
- ui-agent-preset cluster: 1b87a2a8(host), 5b4be3cf, cec4e70f, a56e82e5, 2426d398, d52227c1, 5577beca, e6499814, 3c20f401.
- subagent terminology: 3675e91c, 19675fd0, a2278b46, f132684c, 995caa05.
- document preview cluster: 37ffaa52, e0e83279, ed4445b0, 767cb385, 9b27cc05, 19736552, 7951cee0, 7f0a53df, caa4b8fe, 2a0531e9, b0ad792e.
- connection/session resilience: fa2abdd6, e3f0d3fb, 5c8933fb, 50ba2c8b, e44efede, b1921cf5(hmr).
- welcome/onboarding notice: 4374c204, 441939ea, cd57af49 (0.2 preview notice — port copy to our onboarding surface).
