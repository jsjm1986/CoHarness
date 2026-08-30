# Agent Note: Store pi-ai grants as JSON-compatible values

Status: implemented

English | [中文](2026-08-30-pi-ai-grant-json-image.zh.md)

## Problem

pi-ai OAuth grants may include optional members as explicit `undefined`. The credential record validator stores JSON values and rejected those grants after authorization, even though the absent members carry no information.

## Decision

The pi-ai credential adapter projects grant objects to their JSON image before `modifyRecord`: own object properties whose value is `undefined` are omitted and undefined array entries become `null`, matching `JSON.stringify`. Foreign prototypes and non-finite values are not coerced, so genuinely unrepresentable payloads still fail at the durable boundary.

## Alternatives considered

**Whitelist known OAuth fields.** Rejected because pi-ai can add provider-specific grant members and a whitelist would silently discard them.

**Store the grant object verbatim.** Rejected because explicit undefined members are not valid durable JSON and make sign-in fail after the provider succeeds.

**Coerce every value through JSON.stringify.** Rejected because dates, non-finite numbers, and foreign objects need to remain visible to the validator rather than being silently changed.

## Consequences

Common Copilot-style grants persist without a spurious validation failure while provider-owned fields remain opaque. Invalid non-JSON values continue to produce an actionable store error.

## Testing

The pi-ai auth tests cover nested undefined object members, undefined array entries, scoped record addressing, and the resulting stored record.
