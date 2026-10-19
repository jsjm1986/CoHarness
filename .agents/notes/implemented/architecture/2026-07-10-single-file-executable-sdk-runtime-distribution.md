# Agent Note: Executable SDK runtime distribution

Status: implemented

English | [中文](2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)

## Problem

The Python SDK needs a platform runtime without a separately installed Node.js. Its executable must load ESM plugins through standard package resolution and expose the same stdio JSON-RPC service used by the SDK. Profiles and explicit patch files must retain authority over composition, and repository developers need an explicit Node-based carrier for source debugging.

## Decision

### Enhanced SEA and configuration ownership

The executable uses `@yao-pkg/pkg@6.21.0` with `--sea`, targeting Node 24. The enhanced SEA layer adds a `/snapshot` virtual filesystem and module hooks while preserving ESM and top-level await. One invocation builds one target. This VFS is unrelated to the repository's replay snapshots.

The recorded macOS arm64 Node 24 proof established bare-specifier ESM imports inside the VFS, CJS interop, `node:sqlite`, a shared Cordis instance, failure for missing packaged names, imports of on-disk ESM, unchanged `file:///snapshot/...` module URLs, and ad-hoc signing. Those observations do not substitute for acceptance on another platform or a later artifact.

[The protocol package](../../../../packages/sdk/server/README.md) owns the JSON-RPC service and stdio transport. A composition that does not mount it legitimately does not serve. Protocol shutdown responds and flushes before disposing the root and exiting; plugin unload stops the service without exiting the process. [The SDK application](../../../../packages/bundle/sdk-app/README.md) binds stdin EOF to the CLI launcher's bounded successful shutdown. The launcher disposes and exits with 0 on SIGTERM and 130 on SIGINT. A pipe must remain open until the requested turn finishes.

The Python client launches `dsh --profile sdk` by default. Its `profile` selects another composition, and its ordered `patches` become `--patch` arguments. The client requires an explicit `dsh_home` or a non-empty `DSH_HOME`; it does not select the user's default home implicitly. The shared `runtime-bootstrap.mjs` dispatches both carriers into the CLI.

### Installed package closure and external resources

The CLI's [profile loader](../../../../packages/boot/app-boot/README.md) computes runtime package resolution from the installation and ordered bundle dependency graphs. The installation takes precedence for the names it supplies; relative inserted plugins resolve against their patch file. Both SDK carriers use runtime resolution, and packaged executables enforce that mode. Arbitrary external plugin dependency compatibility is not guaranteed; relative imports do not by themselves establish a shared Cordis identity.

[`python/sdk-runtime/package.json`](../../../../python/sdk-runtime/package.json) is the separate, private deployment manifest. The application bin declares its runtime imports; the carrier declares the shipped plugin closure. [Closure verification](../../../../scripts/verify-runtime-closure.ts) checks shipped presets across the platform matrix and traverses required workspace peers. Unsupported platform expressions remain active during verification so they cannot hide a missing dependency.

The builder uses `pnpm deploy --legacy --prod` with hoisted layout, automatic peer installation disabled, and workspace linking enabled. Legacy deploy supports this workspace configuration; hoisting supplies one package identity, disabled peer installation keeps the closure explicit, and workspace linking selects local dependencies. The builder restores omitted direct packages, materializes package links, removes `.bin` links, and rejects remaining symlinks or missing dependencies. Workspace overrides keep vendored dependencies local. Package `files` declarations must include generated shared chunks.

The [builder](../../../../scripts/build-exe-for-python-sdk.ts) packs declared runtime assets, including plugin icons, and emits the executable plus native ripgrep, Office dependencies, platform resources, and the macOS spawn helper where required. The resource inventory belongs to the builder and [platform manifest](../../../../python/sdk-runtime/platforms.json). Developer-carrier synchronization preserves relative resource symlinks and executable modes so relocating the copied tree does not depend on its build directory. The shared pkg patch publishes extracted native files by temporary-file rename instead of exposing a partially written cache file.

MCP clients can connect to configured external servers; the runtime does not bundle those servers. [The MCP implementation](../../../../packages/mcp/mcp-client/README.md) supports tools and resource reads, with no server enabled by default. MCP prompt templates and resource subscriptions remain unsupported.

### Carriers, platforms, and isolated execution

Automatic Python resolution selects the executable carrier. `DSH_RUNTIME_MODE=node` explicitly runs the development closure's `runtime-bootstrap.mjs` with system Node.js within the [repository engine range](../../../../package.json); this carrier is excluded from wheels.

The [platform manifest](../../../../python/sdk-runtime/platforms.json) declares Linux x64/arm64, macOS arm64/x64, and Windows x64, with executable names beginning `deepseek-harness-sdk-runtime-` and a Windows `.exe` suffix. The [release builder](../../../../scripts/build-python-release.py) derives both Python package versions from the root repository version, converts prereleases to PEP 440, and makes the SDK depend on the exact runtime version. A supplied `python-v` tag must agree; development sentinel versions cannot determine a release. It carries licenses and runtime notices, builds the platform-independent SDK wheel and platform-tagged runtime wheels, and validates the executable, sidecars, and resources. The runtime package rejects sdists, universal tags, unsupported platforms, and mixed or incomplete payloads.

The [GitHub workflow](../../../../.github/workflows/build-exe-for-python-sdk.yml) owns native build and wheel-install validation for its selected targets, including Linux ABI checks and macOS deployment-target checks. Required PR validation and publication select their matrices through their owning workflows. [GitLab publication](../../../../.gitlab-ci.yml) owns its configured build subset and serialized registry publication. Configured jobs are not evidence that those jobs passed.

The packaged bootstrap dispatches Windows ACL runner argv, the Node PTC environment selector, and the private subprocess selector before starting the JSON-RPC agent. Selectors are consumed before guest execution. The [workflow provider](../../../../packages/workflow/workflow-ptc/README.md) uses the shared Node PTC executor and the calling Session's file policy; it does not require a separate workflow worker-thread carrier.

## Alternatives considered

**Bare Node SEA.** Rejected for this packaging design because its blob supplies no package filesystem or standard bare-name resolution. Statically registering every plugin would replace configuration-driven package loading.

**Standard pkg mode or pre-converting all ESM to CJS.** The recorded standard-mode proof failed dynamic imports with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`; its patched Node binaries also lacked the required macOS arm64 prebuild. Enhanced SEA preserves the module semantics without that conversion layer.

**Put the deployment closure in the application bin.** Rejected: it would declare packaging dependencies that the bin does not import and require package-rule exceptions. A dedicated carrier keeps the application package's actual dependencies meaningful.

## Consequences

Users receive Node and the shipped Harness plugins with the platform runtime. The executable and its required resources form one installation; the executable alone is not a complete payload. Package resolution and external configuration remain authoritative in both carriers.

Source remains readable in the VFS; this is not an obfuscation scheme. The original proof produced an executable of roughly 174 MB, not a current total-installation size guarantee. The community-maintained VFS and module hooks remain pinned dependencies, and changes require artifact-level verification.

## Verification

Python unit tests cover protocol handling, subprocess cleanup, cwd propagation, and carrier selection. [Runtime smokes](../../../../scripts/smoke-python-runtime.py) exercise the built executable and installed wheels through default and custom configuration, direct protocol use, persistent Shell state, filesystem search, MCP discovery before the first prompt, dynamic plugins, PTC/workflow execution, and recovery transcripts. The minimal profile supplies one persistent Shell; the editor smoke explicitly mounts its editor overlay. Keyless replay compares SDK output and durable parent/child Session logs. These executable-specific fixtures remain separate from ACP replay because they exercise another protocol and artifact.
