# Agent Note: Centralize browser-safe client primitives

Status: implemented

English | [中文](2026-08-30-browser-safe-client-foundations.zh.md)

## Problem

Browser clients can run on an insecure HTTP origin or in a worker where the secure-context-only `crypto.randomUUID` method is unavailable. Scattered fallbacks also risk weak identifiers and duplicate byte encoders. User-visible CJK and Latin text additionally needs consistent spacing without changing code, diff, terminal, or other literal output.

## Decision

`@deepseek-ai/dsh-util-crypto` owns the cross-runtime `randomUUID` and bounded `bytesToBase64` primitives. UUIDs use `crypto.getRandomValues` with RFC 9562 v4 and have no insecure pseudo-random fallback. Browser-facing session, workspace, attachment, RPC, command, proxy, and LLM request consumers use this package; the client bundle treats it as an inline-safe, stateless utility so insecure-origin clients do not need a module-table row. The web base stylesheet enables `text-autospace: normal` for prose and opts literal/code-like surfaces out with `no-autospace`.

## Alternatives considered

**Keep calling `crypto.randomUUID` and rely on HTTPS.** Rejected because local HTTP deployments and workers are supported runtime contexts.

**Fall back to `Math.random` or timestamps.** Rejected because identifiers would lose the cryptographic uniqueness guarantee and make collisions harder to diagnose.

**Apply automatic spacing to every element.** Rejected because code, diffs, terminal output, and search/read payloads are literal data whose bytes must remain unchanged.

## Consequences

Client identifiers and attachment encoding have one tested owner and remain available across supported browser contexts. Host-side tests that force identifier failures now intercept this owner directly, so lifecycle failure coverage cannot silently drift back to the global Web API. The dsh release closure includes the utility tarball in packed-install rehearsal, keeping published consumers from falling back to a registry lookup before the family is released. The new CSS improves mixed-script prose while explicit literal selectors preserve rendered source text. The utility requires a functioning Web Crypto `getRandomValues` implementation; environments without it fail loudly instead of silently weakening security.

## Testing

The utility tests cover v4 shape, uniqueness, insecure-context method absence, empty/binary/large base64 input. The packed-install closure includes `packages/util/crypto` so the publish-path rehearsal installs the same local dependency that the dsh release family publishes. Web stylesheet tests cover the prose rule and literal-output opt-outs. Consumer connection, runtime, conversation, and attachment tests continue to exercise the shared helpers.
