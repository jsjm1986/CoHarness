# Agent Note: Project-scope Remote classification for plugin surfaces

Status: implemented

English | [中文](2026-08-17-project-scope-plugin-inventory-remote.zh.md)

## Problem

`authorizeTypertRemote` applied project collaboration ACLs by classifying each Typert Remote endpoint in `PROJECT_TYPERT_SESSION_AUTHORIZATION`, a table whose every row extracts a Session identity and authorizes against that conversation's root ACL. Any endpoint absent from the table fell through to a `manage`-class refusal, so in a shared project runtime two read-only surfaces failed for every participant, including administrators: the Web Settings → Plugins → Plugin list tab (`pluginInventory/list`, a Loader projection with no Session identity) and the whole dynamic Cordis panel and approval flow (`dynamicCordisRunner/inventory`, plus every run, render, and invoke Remote). The panel reported "Reading the plugin inventory failed: collaboration-forbidden", and an approval-gated run could never be answered from a project scope.

## Decision

Remote authorization now has three explicit layers, all fail-closed on omission.

1. `PROJECT_TYPERT_SESSION_AUTHORIZATION` classifies every Remote whose wire arguments carry the target Session as `agentId`. The dynamic Cordis run surface joined `goals/*` and `messageFeedback/*` there: `runHostHalf` and `resolveRequestRun` settle a human approval (`approve`, which the Gateway grants only to `rw` participants), `getClientCode` renders a readable session's run card (`read`), and `settleUserRun`, `stopFromPanel`, `undefineFromPanel`, `reportRenderFailure`, and `reportClientGuardFailure` mutate session-scoped run state (`write`).
2. `PROJECT_TYPERT_PROCESS_WIDE_READS` admits process-wide reads with no Session identity after principal capture has verified membership: `pluginInventory/list` and `dynamicCordisRunner/inventory`. Because the inventory rows carry per-Session plugin metadata, the owning service filters them: in project scope `inventory()` drops rows whose Session is outside `authority.readableSessionIds`, so private conversations never reveal their Plugin metadata; personal scopes and collaboration-free compositions keep every row.
3. Registry-resolved authorization covers the two Remotes whose wire arguments carry no Session identity because only the host registry knows it: `resolveRequestRun` authorizes `approve` against the pending request's owning Session, and `invoke` authorizes `write` against the Plugin's owning Session, both inside `DynamicCordisRunnerService` through the shared `collaborationRefusal` (now exported from `dsh-collaboration`, the one home for the refusal's code/message/details mapping). AsyncLocalStorage carries the request principal into the service, so `capture()` resolves the same authority the apiproxy sees.

   However, the apiproxy's `authorizeTypertRemote` fires before the service is reached, and an endpoint absent from all three tables is rejected with `manage` before the service can authorize. A fourth admission set `PROJECT_TYPERT_REGISTRY_AUTHORIZED` therefore admits `resolveRequestRun` and `invoke` past the default deny so the service's own per-Session authorization can run. The admission is gated by the same principal capture that verified project membership, so no unauthenticated caller reaches the service.

Unclassified endpoints keep the default `manage` refusal; the deny test uses `commands/execute`, a real mutating process-wide Remote that must stay refused. `dynamicCordisRunner/syncInspectManifest`, `resolveInspectQuery`, and the inspect surface remain unclassified and denied in project scope until individually classified.

## Alternatives considered

**Classify the inventory inside the session table.** Rejected because the table's contract requires a Session identity extractor and a per-conversation ACL; a process-wide read has neither, and a synthetic session would authorize the wrong resource.

**Admit every `dynamicCordisRunner/*` Remote as process-wide reads.** Rejected because `runHostHalf` and `invoke` execute host code on behalf of a conversation; their authorization must target that conversation, not mere membership.

**Thread `agentId` through the `resolveRequestRun` and `invoke` wire.** Rejected because the client's knowledge of the Session is not authoritative — the registry is. Wire-derived identities belong in the apiproxy table; registry-derived identities authorize where the registry lives.

**Deny the surfaces and hide the tabs in project scope.** Rejected because the plugin inventory and the approval flow are operational surfaces of the shared runtime every member is attached to; hiding them makes project sessions harder to inspect and leaves approval-gated runs unanswerable.

## Consequences

Adding a project-visible Remote requires an explicit classification in one of the three layers; omission keeps the fail-closed default. An `ro` project member can read the plugin inventory, render run cards, and see approvals, but writing run state, settling approvals, and invoking host methods require `rw`; a running Plugin's browser panel therefore cannot call its host methods as an `ro` viewer until `invoke` is given a finer classification. The dynamic Cordis inventory became async; host-side callers await it. `dsh-cordis-host-runner` gained a peer dependency on `dsh-collaboration` and a project reference to it.
