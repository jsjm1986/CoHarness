# Agent Note: Turn-trigger opener and turn-end-anchored completed-Turn footer

Status: implemented

English | [中文](2026-10-18-turn-trigger-and-turn-end-anchored-tail.zh.md)

## Problem

Two presentation defects shared one root cause — the Chat projection did not honor the recorded `turn/end` boundary. First, a non-human `user/message` that opens a Turn (a schedule, goal, agent, webhook, or tool-job notice claimed from the next-turn Inbox) projected as a generic `context` row, so it folded into the completed Turn's process evidence and the durable reason the Turn exists disappeared behind the disclosure. Second, the completed-Turn footer anchored beside the closing Assistant instead of the recorded `turn/end` event, so claimed steering or context rows logged between that Assistant and the boundary rendered after the footer; branch also handed the Host the closing message's seq rather than the boundary's.

## Decision

Inbox classification is split into two persistent Definitions: `inbox-next-step` keeps its existing semantics, and `inbox-next-turn` tracks claims that admit messages into the next Turn. Each claim records its `claimSeq` and whether a human message was admitted (`claimedHuman`), so `user/message` classification can consult both claim sets. A non-human message in the current next-turn claim, or an idle non-human next-step steer that opens Step 1 after `turn/start` with no later next-turn claim and no human in the claim, carries `waking: true` on its context state and `buildViewNode` maps it to a new `turn-trigger` node kind. The kind is registered in `TURN_PROCESS_INDEPENDENT` and at the `input` group-tree position, so it survives completed-Turn folding; `turn-trigger.ts` chooses a localized source label, and `TurnTriggerNodeView` renders the notice behind its own disclosure.

The turn tail keeps the recorded `turn/end` payload seq in `data.seq` and anchors at `data.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup`, so the footer sorts after every transcript row the boundary actually closes. `TurnTailNodeView` inspects the Turn's location index for the final meaningful node — reasoning deltas and tool calls do not count as meaningful — and publishes `data-actions-reveal="always"` only when that node is an assistant reply; otherwise the action row stays hover-revealed. Branch calls `forkAt(data.seq)`, handing the Host the recorded boundary seq. No Session event, model, or durable-event change is involved; this is projection and presentation only. This narrows the anchor and reveal mechanics of the earlier [completed-turn-tail eligibility decision](2026-08-02-message-fork-actions-require-completed-turn-tail.md), whose boundary-based eligibility stands.

## Alternatives considered

**Render the opener as an ordinary context row with a label.** Rejected because generic context rows fold into the completed Turn's process window, hiding the reason the Turn ran exactly when the transcript is collapsed.

**Keep the footer anchored to the closing Assistant.** Rejected because it places the footer mid-turn whenever claimed steering or context follows the final answer before `turn/end`, and it hands fork a seq inside the turn rather than the boundary the Host copies.

**Always reveal footer actions on a completed tail.** Rejected because a steering, tool, or interrupted tail is not the response the reader continues from; hover-only keeps chrome proportional to the content's role.

## Consequences

A schedule or tool-job opener reads as an independent labeled row in both open and folded views, a completed footer always sits at the true end of its Turn, and fork cuts at the boundary the Host expects. Legacy compatibility projection treats `turn-trigger` as context content. The classification matrix (unclaimed, canceled, requeued, human-owned, later-step, pre-turn, and non-member inputs) and the anchoring/folding/hover behaviors are pinned by definition-level and ChatView specs. The split refines the single inbox Definition the [Conversation node-assembly](../architecture/2026-08-09-client-conversation-node-assembly.md) minted.
