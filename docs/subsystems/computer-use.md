# Computer use

English | [中文](computer-use.zh.md)

Computer use lets a model observe and operate the local desktop through a configured provider. The shared DSH capability is called **computer use**; **Cua Driver** names the upstream implementation.

## Choose a provider

Mount [`dsh-computer-use`](../../packages/computer-use/computer-use/README.md) and one provider in the same composition. Both Cua Driver providers are experimental public npm packages and require explicit activation.

| Provider | Runtime |
|---|---|
| [Cua Driver MCP](../../packages/experimental/computer-use-cua-driver-mcp/README.md) | An already installed `cua-driver` executable connected through MCP |
| [Cua Driver native](../../packages/experimental/computer-use-cua-driver-native/README.md) | The platform-native runtime installed with the npm dependency |

Each provider supplies its upstream tool catalog. The shared service reserves one named provider and rejects a second registration, including the same name. Providers route actual effects through its deployment authorization callback; tool schemas and driver operations remain provider-owned. The model cannot select a provider.

## Lifetime and desktop sharing

A provider retains its registration while it shuts down its tools and owned resources. Startup failure releases the attempted registration. The MCP provider keeps its registration during reconnects.

One registered provider does not reserve a desktop for a Session. Callers coordinate complete observe, act, and verify workflows across Sessions and separate DSH processes. A cancelled call cannot undo input that the desktop already received. Gateway runtimes mount a provider only when the node declares an interactive desktop ([managed desktop](../../gateway/deploy/README.md)); managed operations then require an active desktop policy and a live Agent, missing policy fails closed, while independent local compositions retain operator authority. The policy cancellation reaches the driver and prevents late results from being published.

The optional confirmation controller on `computerUseAuthorization` handles current-user reads and explicit gestures through the [Session API](../../packages/host/apiproxy/README.md). The [Gateway execution provider](../../packages/context/gateway-execution/README.md) owns live-root inheritance, qualification checks and root workflow leases. Browser consumers import the confirmation value from `dsh-computer-use/types` without Host service declarations.

## Results and platform requirements

Tools use the normal execution pipeline and Session log. Image-capable model routes with an attachment store receive durable screenshots; unsupported image routes receive the existing MCP image diagnostic. Provider READMEs own installation, permission, and platform limitations.

The [decision record](../../.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.md) explains the registration-only service and the two Cua Driver integrations.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputeruse--computeruseregistry"></a>

### `ctx.computerUse` — `ComputerUseRegistry`

Owns one optional provider registration in the shared computer-use service.

```ts cordis-catalog
/**
 * Execute a driver call under the deployment's desktop policy.
 * Managed runtimes never recover local desktop authority when their policy unloads.
 * @param execution - actual tool caller and cancellation.
 * @param operation - native or MCP operation after authorization.
 * @returns the authorized driver result.
 */
async run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>

/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: ComputerUseProviderName): () => Promise<void>
```

Types: [ToolExecution](tools.md)

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)

<a id="ctxcomputeruseauthorization--computeruseauthorization"></a>

### `ctx.computerUseAuthorization` — `ComputerUseAuthorization`

The desktop policy owns authorization and the lease for the complete driver call.

```ts cordis-catalog
/**
 * Verify the actual actor, then hold desktop authority until the call settles.
 * @param execution - exact tool execution, including its live Agent and cancellation.
 * @param operation - driver effect; the supplied signal also carries revocation and lease loss.
 * @returns the result only while the grant remains valid; cleanup is awaited on rejection.
 */
run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
```

Types: [ToolExecution](tools.md)

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
