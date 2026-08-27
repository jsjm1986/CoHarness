/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
  /** Maximum live SDK sessions retained by one runtime. */
  maxSessions?: number
  /** Maximum UTF-8 bytes and number of blocks accepted by one prompt. */
  maxPromptBytes?: number
  maxPromptBlocks?: number
}

const DEFAULT_MAX_SESSIONS = 1_000
const DEFAULT_MAX_PROMPT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_PROMPT_BLOCKS = 1_000

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false
  private initializeTask: Promise<InitializeResult> | undefined
  private initialization: { cwd: string; provider: string; model: string; maxTokens?: number } | undefined
  private readonly maxSessions: number
  private readonly maxPromptBytes: number
  private readonly maxPromptBlocks: number

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    this.maxSessions = positiveOption(options.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions')
    this.maxPromptBytes = positiveOption(options.maxPromptBytes, DEFAULT_MAX_PROMPT_BYTES, 'maxPromptBytes')
    this.maxPromptBlocks = positiveOption(options.maxPromptBlocks, DEFAULT_MAX_PROMPT_BLOCKS, 'maxPromptBlocks')
    const serverOptions = this.options
    const notify = (method: string, params: object): void => { this.notify(method, params) }
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.shuttingDown || this.shutdownTask !== undefined) throw new Error('SDK server is shutting down')
    if (typeof params.cwd !== 'string' || params.cwd.length === 0 || params.cwd.length > 4096
      || typeof params.provider !== 'string' || params.provider.length === 0 || params.provider.length > 256
      || typeof params.model !== 'string' || params.model.length === 0 || params.model.length > 256) {
      throw new TypeError('initialize cwd, provider, and model must be non-empty bounded strings')
    }
    const cwd = resolve(params.cwd)
    const requested = {
      cwd,
      provider: params.provider,
      model: params.model,
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    }
    if (requested.maxTokens !== undefined
      && (!Number.isSafeInteger(requested.maxTokens) || requested.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const sameInitialization = this.initialization !== undefined
      && this.initialization.cwd === requested.cwd
      && this.initialization.provider === requested.provider
      && this.initialization.model === requested.model
      && this.initialization.maxTokens === requested.maxTokens
    if (this.initialized) {
      if (sameInitialization) return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
      throw new Error('SDK server is already initialized with a different configuration')
    }
    if (this.initializeTask !== undefined) {
      if (!sameInitialization) throw new Error('SDK server initialization is already in progress')
      return this.initializeTask
    }
    this.initialization = requested
    const task = (async (): Promise<InitializeResult> => {
      if (!this.hasAdapterFor(requested.provider)) {
        if (requested.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${requested.provider}"`)
        this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
      }
      this.cwd = requested.cwd
      this.provider = requested.provider
      this.model = requested.model
      this.maxTokens = requested.maxTokens
      this.initialized = true
      return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
    })()
    this.initializeTask = task
    void task.then(() => {
      if (this.initializeTask === task) this.initializeTask = undefined
    }, () => {
      if (this.initializeTask === task) {
        this.initializeTask = undefined
        this.initialization = undefined
      }
    })
    return task
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server must be initialized before session/prompt')
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0 || params.sessionId.length > 512
      || !Array.isArray(params.contentBlocks) || params.contentBlocks.length > this.maxPromptBlocks) {
      throw new TypeError('session/prompt sessionId and contentBlocks are invalid or too large')
    }
    let promptBytes: number
    try {
      promptBytes = Buffer.byteLength(JSON.stringify(params.contentBlocks), 'utf8')
    } catch (error) {
      throw new TypeError('session/prompt contentBlocks must be JSON-serializable', { cause: error })
    }
    if (promptBytes > this.maxPromptBytes) {
      throw new TypeError(`session/prompt content exceeds ${String(this.maxPromptBytes)} bytes`)
    }
    const rec = await this.getOrCreateSession(params.sessionId)
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const initializeTask = this.initializeTask
    if (initializeTask !== undefined) await Promise.allSettled([initializeTask])
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    this.initialized = false
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions) {
      throw new Error(`SDK session limit exceeded (maximum ${String(this.maxSessions)})`)
    }
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }

  /** Deliver an observer notification without letting a closed transport unwind the runtime event. */
  private notify(method: string, params: object): void {
    try {
      this.transport.notify(method, params)
    } catch {
      // The peer may have closed independently; shutdown owns the remaining
      // context teardown and no event can revive that transport.
    }
  }
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return resolved
}
