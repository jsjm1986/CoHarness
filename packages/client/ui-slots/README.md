---
description: "Slot registry pure core: typed ordinary Slots and reusable Component Factories, derived props, Store seats, and renderer installation"
kind: "package-library"
---

# @deepseek-ai/dsh-client-ui-slots

English | [中文](README.zh.md)

Slot registry pure core, slot terminal design: SlotMap declaration merging, the `register`/`registerFactory` composition APIs on SlotCore, the derived component-props type family, the store-seat type family, and the renderer installation contract. React types only at runtime — the package is React-free and cordis-free.

One `register({ name, children?, store?, inject?, ...kind }, Component)` call contributes a component into a declared slot and, in the same breath, declares child slots (declaration = render authorization = runtime spec, one table), a store seat, and the registrant's business face. The component is checked at the call site against `ComposedProps` — the intersection of five shares, each derived from its single source of truth:

| share | type | source |
|---|---|---|
| runtime | `PropsRuntime<K>` | SlotMap entry: `owner` (parent's renderSlot call site) + session standard kit + global seat |
| child render | `PropsRenderSlots<S>` | the register call's `children` key set (statically narrowed `renderSlot`) |
| Factory render | `PropsRenderFactories` | the framework seat (`renderFactorySlot`) |
| store | `PropsStore<H>` | the declared handle: `useStore` selector hook + draft-stripped `actions` |
| business | `I` | inferred from the `inject` factory's return |

Chain-kind slots invert keyed routing — entries self-nominate instead of the dispatch site picking an `entryKey`: each registration carries a pure `ChainSelect` selector (plus optional ascending `priority`, ties in registration order), the first non-null return elects its entry and becomes the component's `matched` prop, and all-null falls to the owner's `renderSlotChain` fallback (`ChainRenderOpts`).

A `registerFactory` call installs one reusable Component Factory on a separate single-definition ledger — Factory occurrences render under unrelated parents and have no parent declaration, so `SlotFactoryMap` carries the definition's complete type: scope, occurrence `props`, ordinary `children` declarations (still global Slots matched against `SlotMap`), the optional `store`, `inject`, `locale`, and local `slots` that select one Component per occurrence. Callers render an occurrence through the injected `renderFactorySlot(name, props, { slots })` and the definition reads each choice through `useFactorySlot(name, fallback)`. An occurrence inherits its render-position scope; `renderFactorySlot` accepts no Session identity. Shared Store handles use ordinary scope resolution; a `store` factory function stays lazy until an occurrence first materializes, then mints one handle per render position and rejects a persistent Store spec whose key would collide across occurrences.

The standard-kit interfaces (`SessionStandardProps`, `GlobalStandardProps`) are declared empty here and merged by the runtime package (same declare-merge pattern as SlotMap and SlotFactoryMap keys). The renderer binds the runtime's session and workspace observable sources into selector hooks. Inject factory parameters derive from the declaration (`InjectParams`): session slots get `sessionId`, a declared store appends baked `actions`, nothing else — data access lives in the apply closure's ctx.

The store family (`defineStore` spec in / `StoreHandle<T, A>` out) types the store seat: `init` infers the state schema, `actions` is the complete draft-transform write set, `BakedActions` strips the draft parameter into the callbacks components and inject factories receive. The `defineStore` value implementation lives in the runtime package (the engine's home) and satisfies the `DefineStore` contract exported here. Engine products and the renderer host contract carry bare snapshot sources (`getSnapshot`/`subscribe`), never React hooks — hook binding belongs to the render machinery; only the props-contract hook type (`SnapshotSelectorHook`) lives here.

`SlotCore` seeds the a-priori `'root'` slot at construction and enforces load-time validation (undeclared-slot registration, duplicate child declaration, one shared handle under two scopes, a chain registration without `select` — all throw at register). An entry's disposer collapses its declared child slots recursively: ledger rows, contributions, and store mounts die on one lifecycle axis. Each key also carries a declaration epoch that advances only on declaration and collapse; the runtime uses it for [`ctx.slots.inject`](../runtime/README.md#slot-declaration-injection), independently from ordinary entry versions. `renderer.ts` carries the installation contract (`SlotRenderer`, `SlotRendererHost`) plus `StaleAuthorizationError`/`SlotOwnershipError`; ui-renderer owns both the implementation and its plugin-lifecycle installation. Live inspection uses strict `type: 'slot' | 'factory'` nodes and nests Factory-owned child Slots under their definition; Factory crashes report through the ordinary supervision channel, and an idempotent effect retains per-position Store handles only after React commit. See the [Component Factories note](../../../.agents/notes/implemented/architecture/2026-09-10-component-factories-and-local-slots.md) for the definition/occurrence model.

`SessionAreaProps.sessionId` optionally binds SessionProvider to an explicit Session. Omission follows current selection; an unresolved id renders the empty branch. The renderer resolves that Session’s provide bundle, including its projection and input sources, and observes provider-roster changes through the existing provide notification channel.

## Summary

`dsh-client-ui-slots` lets web client plugins define and compose typed UI regions. Ordinary Slots provide parent-owned extension positions; Component Factories provide reusable assemblies with caller-selected local Components. Both APIs derive scoped state, injection, locale, and child-render props from declaration-merged types and report conflicting definitions during plugin loading. Pair this React-free package with `ui-renderer` when the client needs rendering.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`isLive` scans all records linearly** — fine at UI-plugin registration counts (tens); revisit with an entry→record backref if ledgers ever grow hot.
- **The `__renders` phantom anchor is visible on `PropsRenderSlots`** — the same accepted noise as the type-chain design's `__accepts`: generic method signatures compare loosely across key unions, so the contravariant marker is what enforces "component key set ⊆ children declaration".

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
