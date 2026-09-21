# @deepseek-ai/dsh-typert-registry

English | [中文](README.zh.md)

Runtime registry for generated Typert artifacts. A contribution carries one package face's business reflection and optional live Zod schemas; `ctx.typert` registers both atomically and withdraws them with the calling Cordis fiber. TypeScript analysis and code generation live in [`dsh-typert-generator`](../generator/README.md).

Package reflection is keyed by `<package>#<face>`. Schemas are keyed by `<package>#<name>` and retain the producer's Zod instance. JSON Schema is computed on demand at the consumer edge.

## Summary

`dsh-typert-registry` makes generated Typert artifacts queryable at runtime: each package's reflection, lazy Zod schema factories, and Remote invocation descriptors live under stable keys. A schema is materialized and cached when a consumer first requests it. Registrations are atomic and fiber-scoped: a contribution lands whole or not at all and is withdrawn automatically when the registering component unloads. The same service hosts the lookup and scoped-Context provider registries that Remote calls resolve through. It performs no TypeScript analysis and generates no schemas; the generator and the loader handle those.

## Public API

- `TypertRegistry` is the default plugin and provides `ctx.typert`.
- `ctx.typert.lookups.register()` registers the wire declaration and default resolver owned by the business package; `configure()` registers a resolver owned by Host composition that may run asynchronously. Their lifetimes are independent: configuration may precede the provider, and unloading the configuration restores the default policy.
- `ctx.typert.contexts.registerHost()` and `configureHost()` apply the same ownership split to scoped Context identity; `registerClient()` supplies the corresponding Client Context binder.
- `register(contribution)` rejects malformed identities and duplicate package-face or schema keys before committing anything, then returns the exact Cordis effect disposer.
- `get(key)`, `resolve(key)`, and `list(filter?)` query live schemas. `resolve()` distinguishes a malformed key, an absent package, and a package that contributes no schema under that name.
- `getPackage(packageName, face?)` and `listPackages(filter?)` query generated service, event, and object reflection; the default face is `host`.
- `toJSONSchema(key, params?)` projects a live schema with `z.toJSONSchema()` without caching the result.
- `typertKey()` and `typertPackageKey()` compose the two stable identity forms.

The `@deepseek-ai/dsh-typert-registry/types` subpath contains the pure contribution and record contracts. [`dsh-typert-loader`](../loader/README.md) discovers and registers generated host artifacts in Loader compositions; direct `ctx.typert.register()` supports other composition owners.

## Model Experience

None, as this runtime type registry's consumers (cordis_inspect, wire faces, gates) own any model-visible projection of registry contents.

#### KV Cache effect

No direct effect; a consumer that places reflection or schemas in a request owns the resulting prefix change.

## Known Limitations and Deferred Work

- The registry stores generated reflection but does not merge host and client graphs or resolve TypeScript references. Those are analyzer and emitter concerns.
- Schema keys omit the face because host and client run in separate contexts. Registering same-named schemas from both faces into one context is rejected as a duplicate.

## Invariants

**Runtime invariant:** No companion is published. Contributions register atomically and withdraw with the calling fiber, so the registry's contents are exactly the live effect set proven by disposal specs.
