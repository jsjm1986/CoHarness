/**
 * The `Branded<B>` / `BrandedNumber<B>` nominal-typing primitives — a type-only
 * utility (no runtime code, no harness-package dependency) shared by every
 * package that owns a cross-boundary id or ordinal.
 *
 * A brand makes structurally identical strings or numbers non-interchangeable
 * at the type level: a `SessionId` cannot be passed where a `CallId` is
 * expected, and an event sequence (`SessionSeq`) cannot be passed as a log
 * offset (`SessionLogOffset`), even though both are plain primitives at
 * runtime. Construction goes through a per-brand factory in the OWNING package
 * (a plain cast inside — zero runtime cost); comparison, logging, and
 * serialization retain the underlying primitive behavior.
 *
 * Policy: a package brands the values it owns — `CallId` in dsh-llm (tool-call
 * correlation), the shared agent/session `SessionId` plus the `SessionSeq` /
 * `SessionLogOffset` ordinals in dsh-session, and `JobId` in dsh-jobs. Branding
 * is for values that cross package boundaries and could plausibly be confused;
 * not every string or number needs a brand.
 * This package owns ONLY the primitives — no concrete id, no runtime code beyond
 * the (erased) types — so the brand vocabulary stays dependency-free and a
 * package can brand its values without depending on an unrelated capability
 * package.
 *
 * @module @deepseek-ai/dsh-brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** A number carrying a compile-time-only brand `B`. */
export type BrandedNumber<B extends string> = number & { readonly [BRAND]: B }
