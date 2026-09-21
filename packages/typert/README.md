# Typert

English | [中文](README.zh.md)

Typert separates source analysis, runtime storage, and Loader discovery.

| Package | Role | Cordis key |
|---|---|---|
| [`registry/`](registry/README.md) | Stores runtime package reflection and schemas | `ctx.typert` |
| [`loader/`](loader/README.md) | Discovers Loader entries and registers generated host artifacts | consumes `ctx.loader` and `ctx.typert` |
| [`generator/`](generator/README.md) | Generates runtime artifacts from source types | build-time library |

The [Typert subsystem reference](../../docs/subsystems/typert.md) records the literal public contracts generated from protocol and registry types.


## Summary

With the Typert group, Client environments can call Host capabilities as typed methods and share generated schemas and reflection without hand-written wire code. A build-time generator turns source type declarations into compiler-independent models and runtime artifacts, a runtime registry stores those artifacts, and a Loader integration registers them automatically in Loader compositions. A shared protocol package supplies the Remote-call declarations — decorators, wire descriptors, codecs, and provider contracts — that business packages, generated artifacts, the Host Gateway, and the Client API all consume. This page maps the four packages; each package README owns its configuration, usage, and limits.
