# Agent Note: A folded Chat turn resets its mounted child disclosures

Status: implemented

English | [中文](2026-10-18-chat-fold-disclosure-reset.zh.md)

## Problem

Chat keeps folded process nodes mounted so live updates keep flowing, but the children's disclosure state survived the fold: expand a settled reasoning or tool disclosure, close the turn's process window, and reopening it returned the same booleans still expanded. The seat set `hidden` on the node while keeping its `nodeKey` Hook context, and every disclosure cell (reasoning, context injection, per-call tool cells including nested and PTC calls) owned an unmanaged expanded flag that no parent fold could reach. Upstream resets the same surface by remounting the members and advancing a disclosure generation on hide; that path is unavailable here because unmounting is the behavior the mounted-node design deliberately avoids.

## Decision

Each `ChatNodeSeat` owns a fold-generation source (`createSnapshotStore(0)`) that bumps once per `folded` false→true transition, covering the manual fold and the automatic completion fold identically. The seat hands the source to its `conversation.chat.node` slot through `hookContext` — now a `ChatNodeHookContext` object carrying `nodeKey` and the reset source — and `apply` binds `disclosure`/`disclosureReset` hook factories in the inject `hooks` compartment, the same channel `turnData` already used. A disclosure is expanded only while the generation it opened under equals the seat's current generation, so `useDisclosure` collapses every child on the fold without unmounting the node. `ToolCallTree` reads `useDisclosureReset()` once at its root and threads the version through `ToolCallBranch` to every call cell — including nested and PTC calls — which stores the seat generation it was expanded under and compares on each read. `ReasoningRow` and `ContextInjectionRow` accept the bound `useDisclosure` through their injected props and fall back to an unmanaged local source when rendered standalone.

## Files

- `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx` — owns the fold-generation store and publishes it through `hookContext`.
- `packages/client/ui-conversation/src/client/contract/slots.ts` — `ChatNodeHookContext` replaces the bare string; `ChatNodeInjected` exposes `useDisclosure`/`useDisclosureReset` hook factories.
- `packages/client/ui-conversation/src/client/chat/use-disclosure.ts` — `useDisclosure`, `bindDisclosure`, and `bindDisclosureReset`, ported from the upstream `use-disclosure` semantics.
- `packages/client/ui-conversation/src/client/apply.ts` — binds the three hook factories for every `conversation.chat.node` renderer.
- `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`, `tool/tool-call-disclosure.ts` — the per-call cell stores the expanding generation; the root threads the reset version recursively.
- `packages/client/ui-conversation/src/client/chat/ReasoningRow.tsx`, `chat/ContextInjectionRow.tsx`, `chat/AssistantMarkdown.tsx`, `chat/AssistantNodeView.tsx`, `chat/MessageItem.tsx` — prop threading for the bound disclosure hook.

## Alternatives considered

**Reset by remounting the children on fold.** That is the upstream mechanism, and it throws away the mounted-node design that keeps live content updating while hidden; the fold would also erase transient stream state that has no durable home. The generation comparison resets only the disclosure booleans.

**A global disclosure-clear signal on every fold.** A turn-wide broadcast would also collapse disclosures in other turns sharing the view; keying the generation per seat scopes the reset to exactly the folded window.

**Subscribe inside components.** The client rules forbid business components from owning subscription machinery; the inject `hooks` compartment is the sanctioned channel for registrant-private reactive facts, and `hookContext` already flowed to the same renderers.

## Consequences

Folding a turn's process window — by hand or by the automatic completion fold — collapses every mounted child disclosure so reopening shows the default presentation; nodes and their live content stay mounted and current. Standalone renders of the disclosure rows keep an unmanaged toggle, so existing direct-render tests and previews are unaffected. The [Chat presentation-defaults decision](2026-09-14-chat-presentation-defaults.md) still owns disclosure retention across output and settlement; this note carves out the fold exception. The fold control itself is owned by the [grouped-process-rendering decision](../feature/2026-10-18-grouped-process-rendering.md).

## Verification

`chat-view.client.spec.tsx` drives a manual fold→unfold over settled reasoning, context-injection, and tool disclosures plus the automatic completion fold, asserting `aria-expanded` returns to false while the nodes remain mounted; `tool-call-tree.client.spec.tsx` covers root, nested, and PTC cells resetting on a generation bump; `use-disclosure.client.spec.tsx` pins the standalone toggle, the shared-source reset, and `bindDisclosureReset` liveness.
