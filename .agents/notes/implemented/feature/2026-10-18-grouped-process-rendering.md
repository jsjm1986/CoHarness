# Agent Note: Grouped process rendering and the Turn process fold control

Status: implemented

English | [中文](2026-10-18-grouped-process-rendering.zh.md)

## Problem

Chat rendered every process row between assistant answers as a flat stream, so a completed Turn's reasoning, context, Tool calls, and retries stayed fully expanded regardless of the work-details preference. The `stepGrouping` and `liveProcessDetail` switches in the presentation-policy table existed but had no rendering consumer: compact, standard, detailed, and verbose produced the same surface. There was also no per-Turn process control — upstream's settled `已完成`/`已停止`/`处理失败` fold toggle — and no synthetic node anchored the window that toggle owns, so evidence, answers, and Turn-level rows had no defined fold boundary.

## Decision

The behavior is ported onto the existing `ui-conversation` architecture rather than upstream's split `ui-chat` package. The runtime `ChatSnapshot` publishes `entries` — ordered `ChatFlowEntry` roots that are either a Node (optionally one `groupPart` of a split Node) or a `group` — and a stable live `groups` store of `ChatGroupSnapshot` members; both fields are required, with empty defaults in `EMPTY_CHAT_SNAPSHOT` and literal test builders. A Node's business kind selects a `group-tree.ts` position: `input` (user, steering, `turn-trigger`), `turn` (system prompt, the process control, tail, error, max-tokens), `process` (`model-retry`), or undefined, which joins the process run around it.

`turn-process.ts` projects each Turn's `TurnProcessSpec` — `controlAnchorSeq`, `processStartSeq`, `answerStep`, `answerAnchorSeq`, `inlineReasoning`, and message/Tool-call/subagent counts — and emits a synthetic `turn-process` Node at `turn/start` plus the negative `processControl` offset, so the control renders after the opening human input even when `turn/start` was logged first. `ProcessFlowProjector` partitions the visible Node order into group windows: consecutive unpositioned Nodes between assistant replies form a group whose title comes from `processActivity` categories plus bounded task detail, an `assistant-step` contributes its reasoning part to the run and its response outside it, and `process`-level rows break a run without joining it.

`ChatView` folds behind the control per Turn: members anchored at or after `processStartSeq` and before `answerAnchorSeq` hide, `TURN_PROCESS_INDEPENDENT` kinds and the answer-anchor Assistant stay out, and open, stopped, failed, or input-interleaved Turns never fold. Folded members stay mounted for live updates while `ChatNodeSeat`'s injected disclosure hook resets them; `ChatGroupSeat` holds local `useDisclosure`, groups all Turns under `stepGrouping: 'collapsed'` (compact, standard), only closed Turns under `'history'` (detailed, deferring the latest until next input), and none under `'none'` (verbose), and shows running task detail in open titles only when `liveProcessDetail` is on. `TurnProcessNodeView` paints only for closed Turns with outcome labels and `data-turn-process-*` count attributes, disabled when the window has no content or cannot collapse.

## Alternatives considered

**Copy upstream's `ui-chat` package wholesale.** Rejected because the fork's Chat projection, registration seam (`conversationEvents` vs `uiConversation.events`), and session composition differ; duplicating the package would fork the same surface twice and strand the integrated fixture harness.

**Add only the fold control over flat rows.** Rejected because it drops the category-titled groups and per-group live detail the modes are defined to differ on, leaving the upstream gap half-ported.

**A kind-set alone instead of a position map.** Rejected because `model-retry` must sit between runs — outside groups but inside the fold window — which a single independent-set cannot express; the three-level map mirrors upstream's per-Node `groupTree` semantics with a kind-keyed declaration.

## Consequences

Completed Turns collapse behind one outcome-labeled control, process evidence groups by activity with live-detail only where policy allows, and the four work-details modes now produce visibly different flows; replay, prepend, append, and running-to-settled transitions preserve Node and group identity. The literal `ChatSnapshot` builders and the cordis inspect API catalog gained the new required fields. The grouped flow, fold windows, outcome labels, ordering anchor, disclosure resets, and mode matrix are pinned by `chat-snapshot-fixture`-driven ChatView specs and conversation-node-definition specs. This note extends the [Conversation node-assembly](../architecture/2026-08-09-client-conversation-node-assembly.md) snapshot model with `entries`/`groups`, lands the turn-level process folding the [presentation-defaults decision](../bug-fix/2026-09-14-chat-presentation-defaults.md) delegated, and shares the fold surface with the [fold-disclosure-reset decision](../bug-fix/2026-10-18-chat-fold-disclosure-reset.md), which owns its disclosure semantics.
