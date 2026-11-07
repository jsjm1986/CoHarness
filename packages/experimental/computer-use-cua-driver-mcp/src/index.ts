/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { inspectDesktopEnvironment } from '@deepseek-ai/dsh-native-command'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin identity for the installed Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-mcp'

/** The shared reservation and tool registry must exist before connection. */
export const inject = ['computerUse', 'tools']

/** Installed executable and MCP connection overrides. */
export interface Config {
  /** Auto detects a host desktop; enabled also supports an explicitly configured remote command wrapper. */
  desktopMode: 'auto' | 'enabled' | 'disabled'
  /** Executable path or PATH command; defaults to `cua-driver`. */
  command: string
  /** Arguments passed without a shell; defaults to `['mcp']`. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the MCP client's default. */
  toolCallTimeoutMs?: number
  /** Reconnection overrides; defaults to the MCP client's policy. */
  reconnect: McpClient.ReconnectConfig
}

/** Validate executable options; the MCP client resolves connection defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  desktopMode: z.union(['auto', 'enabled', 'disabled']).default('auto')
    .description('Auto detects a graphical session. Disable for servers without desktop use; enable explicitly for a configured desktop or remote command wrapper.'),
  command: z.string().pattern(/[^\s]/u).default('cua-driver'),
  args: z.array(String).default(['mcp']),
  toolCallTimeoutMs: z.number().min(1),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number().min(1),
    maxDelayMs: z.number().min(1),
    maxAttempts: z.number().min(1).step(1),
  }),
})

/**
 * Reserve computer use and activate the installed Cua Driver's MCP tools.
 * Initial connection or discovery failure rejects activation and rolls back.
 * Disposal retains the reservation until the MCP child has finished teardown.
 * @param ctx - context providing computer use and the tool registry.
 * @param config - validated executable options and optional connection overrides.
 * @returns initial MCP tool-discovery completion.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const lifetime = new AbortController()
  ctx.on('internal/plugin', (fiber) => { if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort() }, { global: true })
  const environment = config.desktopMode === 'auto' ? await inspectDesktopEnvironment() : undefined
  lifetime.signal.throwIfAborted()
  const unavailable = config.desktopMode === 'disabled' ? 'disabled'
    : environment?.state === 'not-detected' ? 'headless' : undefined
  if (unavailable !== undefined) {
    ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'), { unavailableReason: unavailable })
    ctx.inject(['systemPrompt'], (inner) => {
      inner.systemPrompt.section({
        name: 'computer-use:cua-driver-mcp', order: inner.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
        text: unavailable === 'headless'
          ? 'This server has no detected graphical desktop. Local Cua Driver Computer Use is unavailable. Do not attempt local desktop actions. File, terminal and separately configured headless-browser tools remain independent. An administrator can configure a desktop or a remote driver command.'
          : 'Cua Driver Computer Use is disabled in this provider configuration. Do not attempt desktop actions. File, terminal and separately configured headless-browser tools remain independent.',
      })
    })
    return
  }
  ctx.on('mcp/tool-call', async (serverName, invocation, next) => {
    if (serverName !== 'cua-driver-mcp') return next()
    return ctx.computerUse.run({ ...invocation.execution, signal: invocation.signal }, async (signal) => {
      const previous = invocation.signal
      invocation.signal = signal
      try { return await next() } finally { invocation.signal = previous }
    })
  })
  const connection = McpClient.Config({
    command: config.command,
    args: config.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    reconnect: config.reconnect,
    transport: 'stdio',
    serverName: 'cua-driver-mcp',
    failOnStartupError: true,
  })
  // One effect orders child shutdown before release; separate fiber effects
  // unload concurrently and could otherwise admit another live driver.
  let child!: Fiber
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'))
    child = ctx.plugin(McpClient, connection)
    yield child.dispose
  }, 'computer-use-cua-driver-mcp.connection')
  await child.await()
}
