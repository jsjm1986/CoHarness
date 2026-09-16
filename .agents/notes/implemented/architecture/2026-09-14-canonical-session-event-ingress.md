# Agent Note: Canonical session-event ingress validation

Status: implemented

English | [中文](2026-09-14-canonical-session-event-ingress.zh.md)

## Problem

Every path that admits an event into a Session log — live `append`, construction `seed`, persistence `restore`, and the `adopt`/`snapshot` import boundary — must enforce the same payload invariants, or a defect admitted through one path would surface later as a persistence rejection or a silent divergence between the live log and disk. Surface metadata validation already covered placement; request-header field invariants and tool-result failure markers had no equivalent guard.

## Decision

`validateSessionEventData` in `core/session` validates the locally related payload fields of one event without inspecting complete provider payloads:

- `request/header` data and `header` must be objects; the header must omit `system` (durable prompts are `system/message` events), an empty `tools` array, and an empty `adapterDefaults` record.
- `tool/result` carrying an `error` field requires `message.content[0].isError === true`, matching the failure marker its message asserts.

The same call runs on every ingress path: inside `assertSessionEventEnvelope` for seeds and restores, in `Session.append` after the frozen envelope is built, and first in `adoptSessionEvent` — which also runs `validateSurfaceMetadata`, so imported events face the identical placement rules the live log enforces. Restored envelopes reject non-object values (`null`, arrays, primitives) with a located error instead of a `TypeError`. Records whose type is outside the build's known event vocabulary and that carry `ignorable: true` bypass surface eligibility entirely: their opaque `surfaceOp`/`sourceEventSeqs` are retained without affecting history.

## Alternatives considered

Validating only at the JSONL persistence boundary would leave replay seeds, fork seeds, and adopted imports able to construct logs no backend could store. Rejecting legacy `start`/`end` replace keys at the validator — the upstream choice — is not adopted here: committed generations still carry them, and the [session surface](2026-06-18-session-surface.md) note owns the normalize-on-read policy that keeps those logs loadable.

## Consequences

`assistant/message` keeps its CoHarness `sourceEventSeqs` chunk provenance on every surface event; upstream's prohibition is not adopted because `agent-loop` writes the cited chunk set on every completed and interrupted assistant message. A malformed event fails with the payload rule it violates before any provider/model or message-shape check, and a rejected append or seed publishes nothing and leaves derived state untouched. Pre-v3 artifacts reach these rules only through the format chain, whose v2→v3 step moves `header.system` into the `system/message` head; a recorded fixture written straight into a current-generation log must already omit that field. `canonical-envelopes.spec.ts` exercises every invariant across all five entry paths.
