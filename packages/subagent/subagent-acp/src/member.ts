/**
 * Persistent ACP member support: an `LlmAdapter` route whose every model call
 * spawns one ACP child process, attaches to the member's durable ACP session
 * (`session/load` when bound, `session/new` on the first turn), issues one
 * prompt, and disposes the process. The durable ACP session outlives the
 * process, so restart and recovery re-attach by session id; `session/load`'s
 * replayed `session/update` transcript doubles as the recovery proof.
 *
 * `session/load` is an OPTIONAL ACP capability: the provider probes it during
 * `prepareContinuable` so an agent that cannot resume rejects the member at
 * creation instead of failing its first turn.
 *
 * @module @deepseek-ai/dsh-subagent-acp/member
 */

import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  client as createClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientContext,
} from '@agentclientprotocol/sdk'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {
  ExternalBindingStore,
  ExternalMemberSession,
  ExternalMemberTransport,
  ExternalPendingPrompt,
  ExternalRecovery,
  ExternalTurnOutcome,
} from '@deepseek-ai/dsh-subagent/external'
import { externalMemberTurn } from '@deepseek-ai/dsh-subagent/external'
import {
  acpContentText,
  disposeAcpChild,
  toAcpPrompt,
  type PermissionPolicy,
} from './run.ts'

/** The fixed model route the member adapter registers on `ctx.llm`. */
export const ACP_MEMBER_ROUTE = 'acp-member'
/** The `model` value member children resolve when the deployment pins none. */
export const ACP_MEMBER_MODEL = 'acp'

/** Deployment-owned member transport settings (resolved by the provider). */
export interface AcpMemberConfig {
  /** The executable to spawn for each member turn (the ACP agent). */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /** Member ACP session workspace (`cwd` on `session/new`/`session/load`). */
  cwd: string
  /** Auto-answer policy for the child's permission prompts. */
  permission: PermissionPolicy
  /** Extra environment for the member child process. */
  env: Record<string, string>
  /** EOF quiesce window on dispose. */
  disposeEofGraceMs: number
  /** Termination-escalation grace on dispose. */
  disposeGraceMs: number
}

/** One replayed message from a `session/load` transcript — the recovery proof. */
interface ReplayedMessage {
  readonly role: 'user' | 'agent'
  readonly text: string
}

/**
 * One open ACP member session: a live child process bound to a durable ACP
 * session id. Disposal ends the process; the ACP session persists on the
 * agent's side for the next `session/load`.
 */
class AcpMemberSession implements ExternalMemberSession {
  /** Replayed `session/load` transcript — filled only while `loading` is set. */
  private readonly transcript: ReplayedMessage[] = []
  /** Assistant text of the in-flight `session/prompt`. */
  private turnText: string[] = []
  private liveSessionId: string | undefined
  private loading = false
  private disposed = false

  constructor(
    private readonly child: SubprocessHandle,
    private readonly conn: ClientContext,
    private readonly config: AcpMemberConfig,
  ) {}

  get externalId(): string | undefined {
    return this.liveSessionId
  }

  /**
   * Issue the member prompt and collect the turn's assistant text. ACP
   * reports output only through `agent_message_chunk` notifications during
   * `session/prompt`; the response itself carries no text.
   */
  async *turn(prompt: string, signal: AbortSignal): AsyncIterable<string | ExternalTurnOutcome> {
    const sessionId = this.liveSessionId
    if (sessionId === undefined) {
      throw new Error('subagent-acp member: prompt issued before the ACP session opened')
    }
    if (signal.aborted) {
      throw new Error('subagent-acp member: turn aborted before the prompt was issued')
    }
    this.turnText = []
    await this.conn.request(methods.agent.session.prompt, {
      sessionId,
      prompt: toAcpPrompt([{ type: 'text', text: prompt }]),
    })
    yield { text: this.turnText.join('') }
  }

  /**
   * Prove the pending prompt's state from the replayed transcript collected
   * during `session/load`: the prompt text appears among replayed user
   * messages iff the ACP session accepted it, and the agent text that follows
   * it is the settled answer.
   */
  recover(pending: ExternalPendingPrompt, signal: AbortSignal): Promise<ExternalRecovery> {
    void signal
    const index = this.transcript.findIndex(
      entry => entry.role === 'user' && entry.text === pending.prompt,
    )
    if (index < 0) return Promise.resolve({ kind: 'absent' })
    const answer = this.transcript
      .slice(index + 1)
      .filter(entry => entry.role === 'agent')
      .map(entry => entry.text)
      .join('')
    return Promise.resolve(
      answer === '' ? { kind: 'unknown' } : { kind: 'result', text: answer },
    )
  }

  /** Cancel the remote turn best-effort, then quiesce/terminate the child. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const sessionId = this.liveSessionId
    if (sessionId !== undefined) {
      void this.conn.notify(methods.agent.session.cancel, { sessionId })
        .catch(() => { /* a dead child cannot answer cancel */ })
    }
    await disposeAcpChild(this.child, this.config.disposeEofGraceMs)
  }

  /** Internal: mark the window where `session/load` replays the transcript. */
  beginLoad(): void {
    this.loading = true
  }

  /** Internal: close the replay window after `session/load` resolves. */
  endLoad(): void {
    this.loading = false
  }

  /** Internal: stamp the ACP session id once `session/new`/`session/load` returns. */
  bindSession(sessionId: string): void {
    this.liveSessionId = sessionId
  }

  /** Internal: fold one `session/update` notification into transcript or turn text. */
  pushUpdate(sessionId: string, update: { sessionUpdate: string; content?: unknown }): void {
    if (this.liveSessionId !== undefined && sessionId !== this.liveSessionId) return
    if (update.sessionUpdate !== 'user_message_chunk' && update.sessionUpdate !== 'agent_message_chunk') {
      return
    }
    const text = acpContentText(update.content as Parameters<typeof acpContentText>[0])
    if (text === '') return
    if (this.loading) {
      this.transcript.push({
        role: update.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent',
        text,
      })
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk') this.turnText.push(text)
  }
}

/** A live spawned child with its connection and member-session view. */
interface MemberConnection {
  readonly conn: ClientContext
  readonly session: AcpMemberSession
  /** Whether the agent advertised `loadSession` in `initialize`. */
  readonly loadSession: boolean
  /** Tear down the child process; idempotent. */
  dispose(): Promise<void>
}

/**
 * Spawn-per-turn ACP transport. `open` stands up the child process, completes
 * the ACP handshake, and either loads the bound session or creates a fresh
 * one; the caller disposes the returned session after its turn.
 */
export class AcpMemberTransport implements ExternalMemberTransport {
  constructor(
    private readonly config: AcpMemberConfig,
    private readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  ) {}

  /**
   * Verify the configured ACP agent advertises `loadSession` — the continuable
   * gate. Probing costs one spawn at member creation so a one-shot-only agent
   * is rejected before the durable child exists.
   * @param signal - caller cancellation for the probe's lifetime.
   */
  async probe(signal: AbortSignal): Promise<void> {
    const connection = await this.connect(signal)
    try {
      if (!connection.loadSession) {
        throw new Error(
          'subagent-acp member: the configured ACP agent does not advertise '
          + '`loadSession`; it cannot host persistent members',
        )
      }
    } finally {
      await connection.dispose()
    }
  }

  async open(externalId: string | undefined, signal: AbortSignal): Promise<AcpMemberSession> {
    const connection = await this.connect(signal)
    try {
      if (externalId !== undefined) {
        if (!connection.loadSession) {
          throw new Error(
            'subagent-acp member: the configured ACP agent does not advertise '
            + '`loadSession`; the bound session cannot be resumed',
          )
        }
        connection.session.beginLoad()
        try {
          await connection.conn.request(methods.agent.session.load, {
            sessionId: externalId,
            cwd: this.config.cwd,
            mcpServers: [],
          })
        } finally {
          connection.session.endLoad()
        }
        connection.session.bindSession(externalId)
        return connection.session
      }
      const created = await connection.conn.request(methods.agent.session.new, {
        cwd: this.config.cwd,
        mcpServers: [],
      })
      connection.session.bindSession(created.sessionId)
      return connection.session
    } catch (error: unknown) {
      await connection.dispose()
      throw error
    }
  }

  /**
   * Spawn the child, finish `initialize`, and return the live connection —
   * or dispose the child and rethrow on any handshake failure.
   */
  private async connect(signal: AbortSignal): Promise<MemberConnection> {
    if (signal.aborted) {
      throw new Error('subagent-acp member: open aborted before the child spawned')
    }
    const child = this.spawn({
      argv: [this.config.command, ...this.config.args],
      cwd: this.config.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.config.disposeGraceMs,
      env: this.config.env,
    })
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('subagent-acp member: subprocess dropped a piped protocol stream')
    }

    // The notification handler folds into `session` by closure; the session is
    // assigned right after `connect` returns — updates cannot arrive before
    // the handshake completes, so the reference is live whenever it fires.
    const sessionBox: { current: AcpMemberSession | undefined } = { current: undefined }
    const client = createClient({ name: 'dsh-subagent-acp-member' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (sessionBox.current === undefined) {
          throw new Error('subagent-acp member: session update arrived before session creation')
        }
        sessionBox.current.pushUpdate(params.sessionId, params.update)
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        if (this.config.permission === 'allow') {
          const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always')
          if (allow !== undefined) {
            return { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
          }
        }
        return { outcome: { outcome: 'cancelled' as const } }
      })
    const connection = client.connect(
      ndJsonStream(
        NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        NodeReadable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    )
    const conn = connection.agent
    const session = new AcpMemberSession(child, conn, this.config)
    sessionBox.current = session

    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await disposeAcpChild(child, this.config.disposeEofGraceMs)
    }

    try {
      const initialized = await conn.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      return {
        conn,
        session,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        dispose,
      }
    } catch (error: unknown) {
      await dispose()
      throw error
    }
  }
}

/**
 * The `LlmAdapter` serving member children's model calls. Every call resolves
 * through the shared external-member turn driver: durable binding, pending
 * recovery, prompt window, and consumed cursor all live in the store.
 */
export class AcpMemberAdapter extends LlmAdapter {
  constructor(
    private readonly transport: ExternalMemberTransport,
    private readonly store: ExternalBindingStore,
  ) {
    super()
  }

  override providerInfo(provider: string): { readonly id: string; readonly name: string } {
    return { id: provider, name: 'ACP member' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: ACP_MEMBER_MODEL, name: 'ACP member' }])
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      throw new Error(
        'subagent-acp member: auxiliary model calls (compaction, titles, reviews) '
        + 'have no external turn; this member route serves conversation only',
      )
    }
    return externalMemberTurn(options, this.store, this.transport)
  }
}
