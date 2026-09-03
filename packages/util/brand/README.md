# dsh-brand

English | [中文](README.zh.md)

The `Branded<B>` and `BrandedNumber<B>` nominal-typing primitives — a tiny, **type-only** package (no runtime code, no harness-package dependency) shared by every package that owns a confusable cross-boundary value.

## What `Branded` is

A brand makes structurally-identical strings or numbers non-interchangeable at the type level: a `SessionId` cannot be passed where a `CallId` is expected, and an event sequence cannot be passed where a log offset is required, even though both pairs are plain `string`s or `number`s at runtime.

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

/** Brand a string as a SessionId (a plain cast — zero runtime cost). */
export function SessionId(id: string): SessionId {
  return id as SessionId
}
```

Construction goes through the per-brand factory in the owning package. Comparison, logging, JSON serialization, and the wire format behave as for an ordinary string; the brand is erased at compile time.

### Branding a number

Declare a numeric brand in its owning package and apply it only after that package admits the number:

```ts
import type { BrandedNumber } from '@deepseek-ai/dsh-brand'

export type SessionSeq = BrandedNumber<'SessionSeq'>

/** Brand a validated non-negative safe integer as a SessionSeq. */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('SessionSeq must be a non-negative safe integer')
  return value as SessionSeq
}
```

The owning factory validates requirements such as non-negative safe-integer range before the cast. Comparison, arithmetic, logging, JSON serialization, and wire transport retain ordinary number behavior; arithmetic produces an unbranded number that the owner must admit again before it re-enters the domain.

## Policy: brand values that cross package boundaries

A package brands the values it owns — `CallId` in `dsh-llm`, the shared agent/session `SessionId` in `dsh-session`, `JobId` in `dsh-jobs`, and `SessionSeq` versus `SessionLogOffset` in `dsh-session`. Brand cross-package values that could plausibly be confused with another value of the same primitive; not every string or number needs one.

This package owns only the primitive. Keeping it dependency-free lets `dsh-jobs`, for example, brand `JobId` without importing an unrelated capability package merely to reach `Branded`.
