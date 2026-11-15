/**
 * MCP client bridge plugin: connects to an external MCP server and registers
 * its tools on `ctx.tools` under server-qualified public names
 * (`mcp__<serverName>__<rawName>`). Each plugin instance connects to one MCP
 * server; load multiple instances in `cordis.yml` for multiple servers.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is
 * effect-scoped: disposal disconnects from the server, unregisters all tools,
 * and releases the `serverName` namespace reservation. HMR hot-swaps by
 * disposing the old instance and creating a new one; identical `serverName`
 * reproduces identical public tool names.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_MAX_INSTRUCTION_BYTES, RECONNECT_DEFAULTS, resolveReconnectPolicy, startConnection } from './connection.ts'

export { resolveReconnectPolicy } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { registerServerContext } from './server-context.ts'
import { connectionStatusIn, registerStatusCell } from './status.ts'
import type { McpConnectionStatusHandle } from './status.ts'
import { resolveMcpProcessLimits } from './managed-stdio.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export { createMcpToolDefinition } from './tools.ts'
export type { McpResult, McpToolDefinitionOptions } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export type { McpConnectionStatusHandle } from './status.ts'
export type * from './types.ts'
export { probeServer } from './probe.ts'
export { assertTemplateSyntax } from './templates.ts'
export type { McpProbeOptions } from './probe.ts'

/**
 * Read a plugin instance's live connection status from the Fiber it runs on.
 * @param fiber - plugin Fiber or its `ctx.plugin()` handle.
 * @returns the status handle, or `undefined` before the instance registers one.
 */
export function connectionStatusOf(fiber: Fiber): McpConnectionStatusHandle | undefined {
  return connectionStatusIn(fiber)
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-client'

/** Services required by this plugin. */
export const inject = ['tools']

/** Default timeout for individual MCP tool calls and resource requests (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Live `serverName` reservations per registration scope. Agent-scoped MCP
 * servers may reuse a namespace in another Agent, while global instances and
 * duplicates inside one Agent remain mutually exclusive.
 */
const activeServerNames = new WeakMap<object, Set<string>>()

// ---- Config ----

/** Config for connecting to an MCP server via a spawned child process over stdio. */
export interface StdioConfig {
  /** Selects child-process stdio transport. */
  transport: 'stdio'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** TERM-to-KILL grace for each local MCP process (default 2000 ms). */
  processGraceMs?: number
  /** Bound on confirming local managed-range termination (default 5000 ms). */
  processCloseTimeoutMs?: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds;
    * stdio process admission keeps its own 120000 ms default when unset. */
  startupTimeoutMs?: number
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Config for connecting to an MCP server over Streamable HTTP (SSE). */
export interface StreamableHttpConfig {
  /** Selects Streamable HTTP transport. */
  transport: 'streamable-http'
  /**
   * Stable local namespace for this server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`). Must match `[A-Za-z0-9_-]{1,32}` and be
   * unique among live mcp-client instances in the same registration scope.
   */
  serverName: string
  /** MCP endpoint URL. */
  url: string
  /** Additional headers attached to MCP requests. */
  headers: Record<string, string>
  /** Timeout per tool call or resource request in milliseconds. */
  toolCallTimeoutMs: number
  /** Optional budget for one connection attempt plus its initial tool sync, in milliseconds. */
  startupTimeoutMs?: number
  /** Budget for transport closure and local cleanup, in milliseconds (default 5000). */
  closeTimeoutMs: number
  /** Resolve `${credential:…}` in transport strings at runtime and redact resolved values from diagnostics (default false). */
  expandTemplates: boolean
  /** Fail plugin activation when the initial connection or tool synchronization fails. */
  failOnStartupError: boolean
  /** Maximum UTF-8 bytes of attributed server instructions (default 32768). */
  maxInstructionBytes?: number
  /** Automatic reconnect policy after a lost connection; omission uses the defaults. */
  reconnect?: ReconnectConfig
}

/** Configuration for one stdio or Streamable HTTP MCP server. */
export type Config = StdioConfig | StreamableHttpConfig

type StdioConfigInput = Omit<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>
  & Partial<Pick<StdioConfig, 'args' | 'env' | 'cwd' | 'toolCallTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>>
type StreamableHttpConfigInput = Omit<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>
  & Partial<Pick<StreamableHttpConfig, 'headers' | 'toolCallTimeoutMs' | 'failOnStartupError' | 'closeTimeoutMs' | 'expandTemplates'>>
type ConfigInput = StdioConfigInput | StreamableHttpConfigInput

/**
 * Reconnect-policy section schema, exported so a manager composing mcp-client
 * instances (`dsh-mcp-manager`) validates the same fields, defaults, and
 * bounds without restating them.
 */
export const ReconnectSchema: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

export const Config: z<ConfigInput, Config> = z.union([
  z.object({
    transport: z.const('stdio'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    command: z.string().required(),
    args: z.array(String).default([]),
    env: z.dict(String).default({}),
    cwd: z.string().default(''),
    processGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(2_000),
    processCloseTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    expandTemplates: z.boolean().default(false),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
  }),
  z.object({
    transport: z.const('streamable-http'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
    url: z.string().required(),
    headers: z.dict(String).default({}),
    toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    startupTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS),
    closeTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    expandTemplates: z.boolean().default(false),
    failOnStartupError: z.boolean().default(false),
    maxInstructionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_INSTRUCTION_BYTES),
    reconnect: ReconnectSchema,
  }),
])

// ---- Plugin apply ----

/** Programmatic MCP activation with an explicit, retryable cleanup owner. */
export interface McpClientHandle {
  /** Initial connection and catalog readiness; rejects when strict startup fails. */
  ready: Promise<void>
  /** Stop the connection and settle within the close budget; incomplete cleanup
    * is recorded in the Fiber's status cell rather than thrown. */
  dispose(): Promise<void>
}

/**
 * Mount one MCP client and retain its actual transport cleanup independently of Cordis error reporting.
 * A Fiber whose previous cleanup did not settle or failed cannot mount a replacement until the Host restarts.
 * @param ctx - Plugin context carrying the tool registry and registration owner.
 * @param config - Resolved transport and namespace configuration.
 * @returns Startup readiness and a terminal cleanup that tolerates repeated calls.
 */
export function mountMcpClient(ctx: Context, config: Config): McpClientHandle {
  // Fail loud at load: reconnect misconfiguration (including programmatic
  // construction that bypassed Schemastery) rejects THIS instance before any
  // effect registers.
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp-client(${config.serverName}): reconnect`)
  if (config.transport === 'stdio') resolveMcpProcessLimits(config)

  // Reserve the namespace next: a duplicate `serverName` fails THIS instance
  // at load with an actionable error and leaves the earlier instance intact.
  // The status cell belongs to the actual Fiber and survives its reloads.
  let status!: ReturnType<typeof registerStatusCell>
  const releaseNamespace = ctx.effect(() => {
    const owner = scopeOf(ctx) ?? ctx.root
    let names = activeServerNames.get(owner)
    if (!names) {
      names = new Set()
      activeServerNames.set(owner, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    status = registerStatusCell(ctx.fiber, (message, error) => {
      ctx.logger.warn(`mcp-client(${config.serverName}): ${message}`)
      if (!config.expandTemplates) ctx.logger.warn(error)
    })
    return () => {
      if (ctx.fiber.uid === null) status.detach()
      names.delete(config.serverName)
    }
  }, 'mcp-client.serverName')

  // The supervisor owns the client/transport generations, the reconnect
  // loop, and the live tool registrations; disposal stops reconnection,
  // quiesces in-flight work, and unregisters the current generation.
  if (!status.closure().closeConfirmed || status.closure().cleanupError !== undefined) {
    throw new Error(`mcp-client(${config.serverName}): previous connection cleanup is incomplete; restart the Host`)
  }
  const connection = startConnection(ctx, config, reconnect, status)
  registerServerContext(ctx, config.serverName, connection)
  let stopping: Promise<void> | undefined
  const dispose = (): Promise<void> => stopping ??= (async () => {
    // Final unload (uid null) detaches observers before the closed update, so
    // watchers survive HMR reloads but never see the terminal transition.
    if (ctx.fiber.uid === null) status.detach()
    await connection.dispose()
    await releaseNamespace()
  })().catch((error: unknown) => {
    stopping = undefined
    throw error
  })
  // Cordis announces unload before awaiting an unfinished apply(). Closing
  // the transport here releases startup requests that are still awaiting a reply.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    void dispose()
  }, { global: true })
  ctx.effect(() => [releaseNamespace, dispose], 'mcp-client.connection')

  // Block plugin activation on the initial connection + tool discovery so
  // Cordis consumers observe the tools immediately after the fiber activates.
  // When failOnStartupError is true, a failed initial attempt rejects the
  // fiber (Cordis rolls it back); otherwise the error is logged and the
  // supervisor enters its reconnect loop.
  const ready = connection.ready.then((outcome) => {
    if (outcome.error !== undefined && config.failOnStartupError) {
      throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
    }
  })
  return { ready, dispose }
}

/**
 * Connect one MCP server and publish its initial tool generation before activation.
 * @param ctx - Plugin context carrying the tool registry.
 * @param config - Resolved transport and server namespace configuration.
 * @returns After connection and initial tool discovery settle.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mountMcpClient(ctx, config).ready
}
