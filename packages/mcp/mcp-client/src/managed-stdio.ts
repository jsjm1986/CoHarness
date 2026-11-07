/** Managed local MCP processes with SDK-owned JSON framing and protocol discovery. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  Client, ReadBuffer, serializeMessage, SdkError, SdkErrorCode, isJSONRPCResponse, DEFAULT_REQUEST_TIMEOUT_MSEC,
  type JSONRPCMessage, type PriorDiscovery, type Transport, type DiscoverResult,
} from '@modelcontextprotocol/client'
import type { StdioConfig } from './index.ts'
import type {} from '@deepseek-ai/dsh-agent'

/** A disposable discovery process must never execute the serving initialize handshake. */
class LegacyDiscovery extends Error {}

/** Explicit process and startup limits resolved before registering any owner. */
export interface McpProcessLimits {
  /** TERM-to-KILL grace for each managed process. */
  graceMs: number
  /** Bound on confirming the complete managed range after termination. */
  closeTimeoutMs: number
  /** Deadline covering admission, discovery and the serving handshake. */
  startupTimeoutMs: number
}

/**
 * Resolve deployment limits once, including callers that bypass the Loader schema.
 * @param config - Local stdio server configuration.
 * @returns Validated process, observation and startup budgets.
 */
export function resolveMcpProcessLimits(config: StdioConfig): McpProcessLimits {
  const limits = { graceMs: config.processGraceMs ?? 2_000,
    closeTimeoutMs: config.processCloseTimeoutMs ?? 5_000, startupTimeoutMs: config.startupTimeoutMs ?? 120_000 }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) throw new Error(`mcp-client: ${name} must be a positive timer integer`)
  }
  return limits
}

/** One connection's captured execution attribution and private local process provider. */
export class McpProcessOwner {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<ManagedStdioTransport>()
  private runtime: Promise<SubprocessRuntime> | undefined
  private stopping: Promise<void> | undefined
  private readonly sessionId
  private readonly cwd: string
  /** Validated deadlines retained across discovery and reconnects. */
  readonly limits: McpProcessLimits

  /**
   * Check whether a transport is one of this owner's retained local allocations.
   * @param transport - SDK transport returned by the configured factory.
   * @returns Whether this owner may run its managed discovery flow.
   */
  owns(transport: Transport): transport is ManagedStdioTransport {
    return transport instanceof ManagedStdioTransport && this.active.has(transport)
  }

  /**
   * @param ctx - Connection owner, including an optional exact Agent scope.
   * @param config - Local command and validated deployment settings.
   */
  constructor(private readonly ctx: Context, private readonly config: StdioConfig) {
    this.limits = resolveMcpProcessLimits(config)
    const agents = ctx.get('agents')
    const live = agents?.list() ?? []
    const scoped = scopeChainOf(scopeOf(ctx)).map(key => live.find(agent => agent === key)).find(agent => agent !== undefined)
    this.sessionId = scoped?.id
    this.cwd = resolve(config.cwd || '.')
  }

  private processRuntime(): Promise<SubprocessRuntime> {
    if (this.runtime !== undefined) return this.runtime
    const local = this.ctx.isolate('subprocess').plugin(LocalSubprocessRuntime)
    this.runtime = Promise.resolve(local).then(() => local.ctx.subprocess)
    this.ctx.effect(() => [local.dispose, async () => {
      try { await this.close() } finally { await local.dispose() }
    }], 'mcp-client.local-processes')
    return this.runtime
  }

  /**
   * Create an unstarted transport retained until managed-range cleanup succeeds.
   * @param probe - Whether this process may perform discovery only.
   * @returns A local transport using the maintained SDK frame codec.
   */
  transport(probe = false): ManagedStdioTransport {
    this.lifetime.signal.throwIfAborted()
    const transport = new ManagedStdioTransport(async signal => (await this.processRuntime()).spawn({
      argv: [this.config.command, ...this.config.args], cwd: this.cwd, env: this.config.env,
      ...this.sessionId === undefined ? { resourceOrigin: 'infrastructure' as const } : { sessionId: this.sessionId },
      signal: AbortSignal.any([signal, this.lifetime.signal]), graceMs: this.limits.graceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    }), this.limits, probe, () => { this.active.delete(transport) }, (error) => { this.ctx.logger.error(error) })
    this.active.add(transport)
    return transport
  }

  /**
   * Discover on a disposable process, drain it, then initialize a fresh serving process.
   * @param client - Serving SDK client and capability configuration.
   * @param transport - Fresh serving transport belonging to this owner.
   * @returns After protocol negotiation and the serving handshake complete.
   */
  async connect(client: Client, transport: ManagedStdioTransport): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.limits.startupTimeoutMs)])
    const probe = this.transport(true)
    const abort = (): void => {
      void Promise.allSettled([probe.close(), transport.close()])
    }
    signal.addEventListener('abort', abort, { once: true })
    let prior: PriorDiscovery
    try {
      signal.throwIfAborted()
      const discovery = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
        capabilities: {}, versionNegotiation: { mode: 'auto' },
      })
      try {
        await discovery.connect(probe, { signal, timeout: Math.min(DEFAULT_REQUEST_TIMEOUT_MSEC, this.limits.startupTimeoutMs) })
        // This transport rejects initialize, so a completed discovery is necessarily modern.
        prior = { kind: 'modern', discover: discovery.getDiscoverResult() as DiscoverResult }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof LegacyDiscovery || probe.legacyHandshake
          || (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed && probe.closedWithoutReply)) {
          prior = { kind: 'legacy' }
        } else throw error
      } finally { await probe.close() }
      signal.throwIfAborted()
      await client.connect(transport, { prior, signal, timeout: Math.min(DEFAULT_REQUEST_TIMEOUT_MSEC, this.limits.startupTimeoutMs) })
    } finally { signal.removeEventListener('abort', abort) }
  }

  /** Stop admission and join every retained probe or serving range; failed cleanup can be retried. */
  close(): Promise<void> {
    return this.stopping ??= (async () => {
      this.lifetime.abort(new Error('MCP process owner disposed'))
      const results = await Promise.allSettled([...this.active].map(transport => transport.close()))
      const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'MCP managed process cleanup failed')
    })().catch((error: unknown) => { this.stopping = undefined; throw error })
  }
}

/** An SDK Transport over a process whose admission and range belong to the local provider. */
class ManagedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** SDK negotiation uses the presence of pid/stderr; native identity remains provider-private. */
  readonly pid = null
  readonly stderr = null
  legacyHandshake = false
  closedWithoutReply = false
  private readonly lifetime = new AbortController()
  private readonly reader = new ReadBuffer()
  private handle: SubprocessHandle | undefined
  private opening: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private closeRequested = false
  private closeReported = false
  private probeId: string | number | undefined
  private probeReplied = false

  constructor(
    private readonly allocate: (signal: AbortSignal) => Promise<SubprocessHandle>,
    private readonly limits: McpProcessLimits,
    private readonly probe: boolean,
    private readonly released: () => void,
    private readonly report: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (this.opening !== undefined) throw new Error('MCP stdio transport already started')
    this.lifetime.signal.throwIfAborted()
    this.opening = this.open()
    await this.opening
  }

  private async open(): Promise<void> {
    this.handle = await this.allocate(this.lifetime.signal)
    const handle = this.handle
    if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
      throw new Error('MCP subprocess provider did not supply protocol pipes')
    }
    handle.stdin.on('error', (error) => { this.notifyError(error) })
    handle.stdout.on('error', (error) => { this.notifyError(error) })
    if (this.probe) handle.stderr.resume()
    else handle.stderr.pipe(process.stderr, { end: false })
    handle.stdout.on('data', (chunk: Buffer) => {
      if (this.closeRequested) return
      try {
        this.reader.append(chunk)
        for (;;) {
          const message = this.reader.readMessage()
          if (message === null) break
          if (isJSONRPCResponse(message) && message.id === this.probeId) this.probeReplied = true
          this.onmessage?.(message)
        }
      } catch (error) {
        this.notifyError(error)
        void this.close().catch(this.report)
      }
    })
    void handle.done.then(() => {
      this.closedWithoutReply = !this.closeRequested && !this.probeReplied
      return this.close()
    }, (error: unknown) => {
      this.notifyError(error)
      return this.close()
    }).catch(this.report)
    this.lifetime.signal.throwIfAborted()
  }

  private notifyError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error('MCP stdio failed', { cause: error })
    try { this.onerror?.(failure) } catch (observerError) { this.report(observerError) }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.probe && 'method' in message && message.method === 'initialize') {
      this.legacyHandshake = true
      throw new LegacyDiscovery('Disposable MCP discovery completed with a legacy verdict')
    }
    if ('method' in message && message.method === 'server/discover' && 'id' in message) this.probeId = message.id
    const stdin = this.handle?.stdin
    if (stdin === undefined || this.closeRequested) throw new Error('MCP stdio transport is not connected')
    const bytes = serializeMessage(message)
    await new Promise<void>((resolveWrite, reject) => {
      stdin.write(bytes, (error) => { if (error) reject(error); else resolveWrite() })
    })
  }

  close(): Promise<void> {
    this.closeRequested = true
    return this.closing ??= Promise.resolve().then(async () => {
      if (!this.closeReported) {
        this.closeReported = true
        try { this.onclose?.() } catch (observerError) { this.report(observerError) }
      }
      this.handle?.stdin?.end()
      this.lifetime.abort(new Error('MCP stdio transport closed'))
      await this.opening?.catch(() => {})
      const handle = this.handle
      if (handle !== undefined) {
        handle.terminate()
        if (!await handle.waitForExit(AbortSignal.timeout(this.limits.closeTimeoutMs))) throw new Error('MCP process range termination was not confirmed')
        await handle.done.catch(() => {})
        handle.stdin?.destroy()
        handle.stdout?.destroy()
        handle.stderr?.destroy()
      }
      this.reader.clear()
      this.released()
    }).catch((error: unknown) => { this.closing = undefined; throw error })
  }
}
