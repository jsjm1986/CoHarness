# Agent Note: Developer tool updates present as compact context notices

Status: implemented

English | [中文](2026-10-15-developer-tool-update-notices.zh.md)

## Problem

The agent loop logs `developer/message` events whenever the tool registry changes between turns — a skill or preset activation adds and removes tool names in durable `tool-addition`/`tool-removal` content blocks — but no conversation target matched the event, so the roster change was invisible in Chat and Trajectory even though it reached the model. Upstream source: `7e5f9069454` (inside alpha.2).

## Decision

Developer history joins the context presentation at both targets. A `developerMessageDefinition` shares the input-message lifecycle in Chat: it projects `data.message` into a `ContextMessageNode` keyed by the message id, so `contextProducer`/`contextForm` run on its durable source exactly like an injected `user/message`. The Trajectory input Definition matches the event on the same node shape. Both renderers special-case content that consists solely of tool-change blocks: one block names the tool inline and is not expandable; several collapse to a `Tools updated` title with added/removed counts and expand to one name list per change kind. A single-tool trajectory cell is presentation-only — it leaves the tab order and gains no select/expand handlers. Mixed content keeps the generic context presentation.

## Alternatives considered

**A dedicated `tool-update` node kind and card.** The context disclosure already owns collapsed-versus-expanded compact geometry, the producer-label convention, and the opaque-body fallback for unknown producers; a second disclosure would duplicate all of it to name the same durable facts.

**Resolving additions against the request header.** The cell presents names, not schemas — the header diff that produced the event is already durable, and resolving a removed tool's schema would require replaying headers the viewer may have paged out.

## Consequences

Tool registry changes surface in both Chat and Trajectory wherever they were durable. A developer message carrying ordinary text renders as an unnamed context row with the opaque body, the documented default. Chat keeps every context row visible, so no visibility exemption is needed; the row suppression upstream applies to ordinary Context does not exist here.

## Verification

`conversation-node-definitions.client.spec.ts` assembles a tool-change event into a context node across replay, live, and prepend windows, and preserves removals without a loaded header. `tool-updates.client.spec.tsx` renders the bilingual collapsed counts and expanded name lists, and the single-block non-expandable title. `conversation-definitions.client.spec.ts` and `layout.client.spec.tsx` cover the trajectory node and cell text/detail projection in both locales.

## Related

- [2026-08-04 Web context source and steer marks](2026-08-04-web-context-source-and-steer-marks.md) — the producer-label convention the notice suppresses for tool-only content.
- [2026-08-05 Context form vocabulary](2026-08-05-context-form-vocabulary.md) — the form axis the generic path still follows.
