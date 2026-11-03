# Agent Note: Memory auxiliary request records and lifetime ownership

Status: implemented

English | [中文](2026-10-24-memory-auxiliary-ownership.zh.md)

## Problem

Extraction and consolidation construct requests from a Session prefix, current memory catalog and intermediate tool results. Recall constructs a separate selector request. These inputs were dispatched through the LLM service without their own durable request record; a later catalog edit prevents reconstructing the earlier model input from current memory state.

Recall cancellation covered turn completion but omitted Session disposal and plugin unloading. Removing the plugin's listeners could leave its model stream running and permit a late memory injection. An already-entered pre-step listener could also resume and start a selector after unloading.

## Decision

Each auxiliary request uses `prepareCall()` to retain one resolved adapter and configuration. Recall logs `memory/recall-request`; every extraction or consolidation round logs `memory/curation-request` with the pass kind and zero-based round. The immutable request includes resolved model settings, messages, tools and tool history when present. Cancellation and authorization objects remain runtime values. A failed append prevents dispatch. Requests explicitly select the triggering Session's execution resource origin and continue through normal LLM policy, admission and metering.

Both `memory-context` and `memory-curation` expose their own validated `maxOutputTokens` configuration. The default remains 5,000, independent of primary conversation settings. Deployments can select a smaller or larger positive safe integer without editing source; zero, fractional and unsafe limits fail configuration validation. The logged prepared request retains that configured cap.

Recall keeps a completion owner independent of its per-Session scheduling marker. Turn completion and Session disposal cancel the current selector; plugin unloading stops admission, cancels every outstanding selector and awaits their stream and read cleanup, including work whose scheduling marker was already removed. A paused pre-step listener cannot start work after unloading. The existing [curation mutation and cancellation rules](2026-10-23-memory-mutation-outcomes.md) continue to govern completed writes and cursor publication.

Feature-setting changes also cancel active recall requests under the [live availability decision](2026-10-31-memory-live-availability.md). The same completion owner joins their cleanup.

Extraction and consolidation retain independent settings cancellation under the [curation live-operation rule](2026-10-31-memory-curation-live-availability.md); their Session lane continues to own cleanup and queued turns.

## Consequences

The two request events are required-on-read vocabulary additions at Session format version 7. Current writers do not mark them ignorable. Older builds that do not know either event refuse the log rather than reconstructing incomplete model inputs. These records do not enter the primary model conversation or change memory-domain records. Extraction cursors continue to identify the reviewed completed turn rather than subsequently appended auxiliary events.

This change owns recall work until that work settles; it does not establish general ordering between unrelated provider resources during enclosing-owner shutdown. The [pending Memory acquisition decision](2026-10-24-memory-domain-open-disposal.md) covers that separate provider path.

## Verification

Negative controls reproduce missing extraction and recall request records and uncancelled selectors after plugin or Session disposal. Unit checks compare the complete logged requests with dispatched inputs, including later tool rounds. Controlled real LLM iterators pause cleanup and prove plugin disposal remains pending until they settle; another barrier proves a paused pre-step listener cannot admit work after unloading.

A shared keyless SDK composition runs the real Loader, JSON memory domain, recall, extraction and consolidation against a deterministic adapter. The adapter compares each complete durable request with its actual input before responding. The TypeScript and Python SDK goldens retain all three request kinds, separately configured 64-token recall and 32-token curation caps, and a completion record proving four model permits acquired, three explicitly attributed to Session execution and all four quiescent. Both SDKs then resume the persisted Session in a fresh runtime and complete another turn. This fixture verifies the LLM admission seam with a controlled permit provider; PostgreSQL scheduling and live model HTTP transport have separate Gateway acceptance evidence.

The fixture checks the live execution-origin permit rather than the last permit acquired: conversation and recall admission can overlap before adapter dispatch. Auxiliary assertion failures reject the waiting primary fixture stream, so a failed attribution check reports its cause instead of hanging the resumed turn.

## Alternatives considered

**Reconstruct auxiliary inputs from the primary request or current catalog.** Consolidation has its own input, tool rounds add results, and catalog contents can change after dispatch.

**Log only route names or use mutable adapter defaults during dispatch.** That omits provider-visible settings and cannot prove the logged request selected the adapter that executed it.

**Abort only selectors still present in the scheduling map.** Turn or Session cancellation can remove that marker while the model iterator is still cleaning up. The completion owner must retain the actual task until settlement.
