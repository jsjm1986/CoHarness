# api/ — Remote API layers

English | [中文](README.zh.md)

The application-facing Remote stack. `remotes` owns BFF policy and the selected business API, while `gateway` implements the Typert unary RPC endpoints shared by Host and Client environments.

| Package | Role | ctx key |
|---|---|---|
| [`remotes/`](remotes/README.md) | Host Agent/Session lookup policy and Client Remote contribution assembly | no service; configures `ctx.typert` and consumes `ctx.remote` |
| [`gateway/`](gateway/README.md) | Host Typert dispatcher and Client Remote endpoint | `ctx.typertGateway` / `ctx.remote` |

The runtime dependency direction is `remotes → gateway → connection → webserver`: the BFF consumes the shared `TypertClientRemote` contract, Gateway delegates transport to Connection, and Connection mounts on the HTTP server. Cordis service injection and Client module metadata preserve this order without importing the concrete Gateway from the Remotes Client entry.

## Summary

The `api/` group provides the application's Remote layer: a Client environment can call the business capabilities running on the Host — manage goals, run commands, list the plugin inventory, discover file and session references — as typed method calls, and receive the results or forwarded Host events. `remotes` decides which capabilities are exposed and how each call reaches the right session's agent; `gateway` carries the calls and their results between Client and Host. The stack runs over the application's shared Connection; streaming session data is deliberately outside it.

## Known Limitations and Deferred Work

- Connection and WebServer remain at [`client/connection`](../client/connection/README.md) and [`host/webserver`](../host/webserver/README.md); a later package-only move can place them under `api/connection` and `api/webserver` without changing their service contracts.
- The legacy API Proxy remains at [`host/apiproxy`](../host/apiproxy/README.md) as the fallback for methods not yet migrated to Remote. It consumes the Host resolver owned by `api-remotes` so migrated and legacy methods retain one Agent/Session identity policy.

The [Typert subsystem reference](../../docs/subsystems/typert.md) records the public contracts shared by protocol, Gateway, and consumer assemblies.
