/** Session-owned user terminals with the execution environment's system-user permissions. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { discoverShells, resolveShell } from './shells.ts'
import { BrowserTerminal } from './terminal.ts'
import { TerminalRetention } from './retention.ts'
import { TerminalAccess, type TerminalAuthority, type TerminalCreatorId } from './authorization.ts'
export type { TerminalAuthority, TerminalCreatorId, UserTerminalAuthorization, UserTerminalAdministration } from './authorization.ts'
import type {
  TerminalShell, TerminalAttachmentId, TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalRetentionFrame,
  WebTerminalId, WebTerminalInfo, TerminalOwnerId, TerminalAdminInfo,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Interactive user terminals, separate from the Agent terminal tool registry. */
    terminalController: TerminalController
  }
}

/** Deployment limits and an optional shell profile. */
export interface Config {
  /** Explicit shell profile; omission uses the execution environment's default shell. */
  readonly shell?: {
    /** Executable path or PATH name, verified by the subprocess provider. */
    path: string
    /** User-visible profile name. */
    name: string
    /** Arguments passed to the interactive shell. */
    args: string[]
  } | undefined
  /** Executable names or paths checked for the new-terminal shell selector. */
  readonly shellCandidates: string[]
  /** Maximum retained terminals and pending allocations per Session. */
  readonly maxTerminals: number
  /** Maximum terminal width in columns. */
  readonly maxCols: number
  /** Maximum terminal height in rows. */
  readonly maxRows: number
  /** Screen history rows retained for reconnecting clients. */
  readonly scrollback: number
  /** Maximum queued UTF-8 frame bytes per output follower before disconnection. */
  readonly maxBufferedBytes: number
  /** Maximum UTF-8 bytes in one input request. */
  readonly maxInputBytes: number
  /** Provider process-termination grace period in milliseconds. */
  readonly disposeGraceMs: number
  /** Continuous confirmed idle time without window holds before reclamation; zero disables reclamation. */
  readonly unattendedTimeoutMs: number
  /** Interval between unattended shell and process observations. */
  readonly activityPollIntervalMs: number
  /** Delay before retrying failed owned terminal cleanup. */
  readonly cleanupRetryMs: number
}

interface TerminalAllocation {
  info: WebTerminalInfo
  readonly cleanup: TerminalRetention
}

interface OwnedSession {
  readonly managementId: TerminalOwnerId
  readonly sessionId: SessionId
  readonly creatorUserId?: number
  readonly creator: TerminalCreatorId
  readonly revoked: () => void
  readonly lifetime: AbortController
  readonly closedIds: Set<WebTerminalId>
  cleanup?: Promise<void>
  readonly terminals: Map<WebTerminalId, BrowserTerminal>
  readonly pending: Map<WebTerminalId, Promise<BrowserTerminal>>
  readonly allocations: Map<WebTerminalId, TerminalAllocation>
}

/** Typed Remote control of transient Session-owned terminal processes. */
export class TerminalController extends TypertRemoteService {
  static inject = ['subprocess', 'sandboxPolicy', 'typert']
  static Config: z<Config> = z.object({
    shell: z.union([z.object({
      path: z.string().required(), name: z.string().required(), args: z.array(z.string()).default([]),
    }), z.const(undefined)]),
    shellCandidates: z.array(z.string().min(1)).default(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd']),
    maxTerminals: z.number().step(1).min(1).default(8),
    maxCols: z.number().step(1).min(2).default(500),
    maxRows: z.number().step(1).min(1).default(200),
    scrollback: z.number().step(1).min(0).default(1000),
    maxBufferedBytes: z.number().step(1).min(1024).default(2 * 1024 * 1024),
    maxInputBytes: z.number().step(1).min(1).default(64 * 1024),
    disposeGraceMs: z.number().step(1).min(1).default(1000),
    unattendedTimeoutMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(7_200_000),
    activityPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
    cleanupRetryMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60_000),
  })

  private readonly owners = new Map<string, OwnedSession>()
  private readonly lifetime = new AbortController()
  private readonly access: TerminalAccess
  private readonly cleanupTasks = new Set<Promise<void>>()

  /**
   * @param ctx - Host context carrying typed Remote and execution providers.
   * @param config - validated terminal limits and optional shell profile.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'terminalController', { namespace: 'terminal' })
    this.access = new TerminalAccess(ctx, this.lifetime.signal)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Terminal controller disposed'))
      const results = await Promise.allSettled([...this.owners].map(([id, owner]) => this.disposeOwner(id, owner)))
      await Promise.allSettled(this.cleanupTasks)
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Browser terminal cleanup failed')
    }, 'terminal-controller.processes')
  }

  /**
   * Reject unauthorized terminal callers before transport lookup can activate an Agent.
   * @param sessionId - codec-validated Session identity from the Remote request.
   * @param signal - request cancellation.
   * @returns after current human authority is confirmed.
   */
  async authorizeSession(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    using authority = await this.access.authorize(sessionId, signal)
    authority.signal.throwIfAborted()
  }

  /**
   * Read the Session working directory and terminal limits without resolving a shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns the Session workspace directory and terminal limits.
   */
  @Remote
  async environment(agent: Agent, signal: AbortSignal): Promise<TerminalEnvironment> {
    using authority = await this.access.authorize(agent.id, signal)
    authority.signal.throwIfAborted()
    return this.environmentOf(agent)
  }

  private environmentOf(agent: Agent): TerminalEnvironment {
    const { sandboxPolicy } = this.execution(agent)
    return { cwd: agent.session.header.cwd ?? sandboxPolicy.workspaceRoot,
      maxInputBytes: this.config.maxInputBytes, maxCols: this.config.maxCols,
      maxRows: this.config.maxRows, scrollback: this.config.scrollback }
  }

  /**
   * Discover installed shells in the Session's execution environment.
   * @param agent - Session owner supplied by the Gateway.
   * @param signal - request cancellation.
   * @returns verified profiles, with the configured or system default first.
   */
  @Remote
  async shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]> {
    using authority = await this.access.authorize(agent.id, signal)
    const shells = await discoverShells(this.execution(agent).subprocess, this.config.shell, this.config.shellCandidates,
      AbortSignal.any([signal, authority.signal]))
    authority.signal.throwIfAborted()
    return shells
  }

  /**
   * List retained terminals without resolving or activating an Agent.
   * @param sessionId - displayed Session identity, including offline history.
   * @returns terminals retained for this Host lifetime.
   */
  @Remote
  async list(sessionId: SessionId): Promise<WebTerminalInfo[]> {
    using authority = await this.access.authorize(sessionId, this.lifetime.signal)
    const owner = this.owners.get(this.ownerKey(sessionId, authority.creator))
    if (owner === undefined) return []
    return [...owner.terminals.values(), ...owner.allocations.values()].map(terminal => terminal.info)
  }

  /**
   * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
   * @param agent - Session owner supplied by the Gateway.
   * @param request - initial dimensions and idempotency identity.
   * @param signal - allocation cancellation; committed terminals survive disconnection.
   * @returns the existing or newly committed terminal.
   */
  @Remote
  async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo> {
    this.lifetime.signal.throwIfAborted()
    if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
    this.dimensions(request.cols, request.rows)
    using authority = await this.access.authorize(agent.id, signal)
    const owner = this.owner(agent, authority)
    owner.lifetime.signal.throwIfAborted()
    this.requireOpen(owner, request.id)
    const existing = owner.terminals.get(request.id)
    if (existing !== undefined) return existing.info
    const pending = owner.pending.get(request.id)
    if (pending !== undefined) {
      const terminal = await pending
      this.requireOpen(owner, request.id)
      return terminal.info
    }
    if (new Set([...owner.terminals.keys(), ...owner.pending.keys(), ...owner.allocations.keys()]).size >= this.config.maxTerminals) throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: this.config.maxTerminals })
    const allocation = this.spawn(agent, owner, request, AbortSignal.any([signal, this.lifetime.signal, owner.lifetime.signal]))
    owner.pending.set(request.id, allocation)
    try {
      const terminal = await allocation
      owner.terminals.set(request.id, terminal)
      owner.allocations.delete(request.id)
      terminal.monitor(this.config, () => { owner.closedIds.add(request.id) }, () => {
        owner.terminals.delete(request.id)
      }, (error) => { this.ctx.logger.error('Browser terminal cleanup failed', error) })
      this.requireOpen(owner, request.id)
      return terminal.info
    } finally {
      owner.pending.delete(request.id)
    }
  }

  /**
   * Retain an existing terminal for a window without activating its Agent or taking input control.
   * @param sessionId - owning Session identity, including an inactive saved layout.
   * @param id - retained Host terminal identity.
   * @param signal - physical Remote stream cancellation.
   * @returns a hold acknowledgement followed by an open lifetime stream.
   */
  @Remote({ mode: 'stream' })
  async * retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    using authority = await this.access.authorize(sessionId, signal)
    const owner = this.owners.get(this.ownerKey(sessionId, authority.creator))
    const terminal = owner?.terminals.get(id)
    if (owner === undefined || terminal === undefined || owner.closedIds.has(id) || owner.lifetime.signal.aborted) {
      throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    }
    yield* terminal.retain(AbortSignal.any([signal, authority.signal, owner.lifetime.signal]))
  }

  /**
   * Attach to a terminal without binding its process lifetime to the transport.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - new exclusive input attachment.
   * @param signal - physical stream cancellation.
   * @returns screen recovery followed by output and metadata changes.
   */
  @Remote({ mode: 'stream' })
  async * follow(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    if (!/^[\w-]{1,128}$/u.test(attachmentId)) throw new Error('Invalid terminal attachment identity')
    using authority = await this.access.authorize(agent.id, signal)
    const { owner, terminal } = this.ownedTerminal(agent, id, authority.creator)
    const combined = AbortSignal.any([signal, authority.signal, owner.lifetime.signal])
    for await (const frame of terminal.follow(attachmentId, combined)) {
      combined.throwIfAborted()
      yield frame
    }
  }

  /**
   * Deliver raw input, including Tab completion and control characters.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - current writable attachment.
   * @param data - input bytes represented as UTF-8 text.
   * @returns after provider input acceptance.
   */
  @Remote
  async write(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, data: string): Promise<void> {
    if (Buffer.byteLength(data, 'utf8') > this.config.maxInputBytes) throw new Error('Terminal input exceeds the configured limit')
    using authority = await this.access.authorize(agent.id, this.lifetime.signal)
    await this.ownedTerminal(agent, id, authority.creator).terminal.write(attachmentId, data)
    authority.signal.throwIfAborted()
  }

  /**
   * Update the dimensions of the PTY and recovery screen.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param attachmentId - current writable attachment.
   * @param cols - column count.
   * @param rows - row count.
   * @returns after the resize completes.
   */
  @Remote
  async resize(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, cols: number, rows: number): Promise<void> {
    this.dimensions(cols, rows)
    using authority = await this.access.authorize(agent.id, this.lifetime.signal)
    await this.ownedTerminal(agent, id, authority.creator).terminal.resize(attachmentId, cols, rows)
    authority.signal.throwIfAborted()
  }

  /**
   * Rename a terminal without changing its shell.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @param title - nonempty display title, at most 120 characters.
   */
  @Remote
  async rename(agent: Agent, id: WebTerminalId, title: string): Promise<void> {
    if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
    using authority = await this.access.authorize(agent.id, this.lifetime.signal)
    this.ownedTerminal(agent, id, authority.creator).terminal.rename(title.trim())
  }

  /**
   * Close an identity to future creation and kill its process range; repeated closes succeed.
   * @param agent - Session owner supplied by the Gateway.
   * @param id - terminal identity.
   * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
   */
  @Remote
  async close(agent: Agent, id: WebTerminalId): Promise<void> {
    using authority = await this.access.authorize(agent.id, this.lifetime.signal)
    const owner = this.owner(agent, authority)
    await this.closeOwned(owner, id)
  }

  private async closeOwned(owner: OwnedSession, id: WebTerminalId): Promise<void> {
    owner.closedIds.add(id)
    // create publishes the allocation before this wait settles; close owns it even if create then rejects.
    await owner.pending.get(id)?.catch(() => { /* Creation reports its failure; close still owns any allocated process. */ })
    const terminal = owner.terminals.get(id)
    if (terminal !== undefined) {
      await terminal.close()
      owner.terminals.delete(id)
    } else {
      const allocation = owner.allocations.get(id)
      if (allocation === undefined) return
      await allocation.cleanup.close()
      owner.allocations.delete(id)
    }
  }

  /**
   * List process metadata without activating Sessions or reading terminal contents.
   * @param signal - administrator request cancellation.
   * @returns current owner coordinates and process states only.
   */
  @Remote
  async adminList(signal: AbortSignal): Promise<TerminalAdminInfo[]> {
    await this.access.administrator(AbortSignal.any([signal, this.lifetime.signal]))
    return [...this.owners.values()].flatMap(owner =>
      [...new Set([...owner.pending.keys(), ...owner.terminals.keys(), ...owner.allocations.keys()])].map(id => ({
        ownerId: owner.managementId, sessionId: owner.sessionId, id,
        ...(owner.creatorUserId === undefined ? {} : { creatorUserId: owner.creatorUserId }),
        state: owner.lifetime.signal.aborted || owner.closedIds.has(id) ? 'stopping' as const
          : owner.terminals.get(id)?.info.state ?? 'starting' as const,
      })))
  }

  /**
   * Terminate exactly one inventory entry without assuming its creator identity.
   * @param ownerId - Host-lifetime owner returned by the current inventory.
   * @param id - terminal within that owner.
   * @param signal - cancellation before admitting termination; accepted cleanup remains owned.
   * @returns after process cleanup succeeds; missing entries are already closed.
   */
  @Remote
  async adminClose(ownerId: TerminalOwnerId, id: WebTerminalId, signal: AbortSignal): Promise<void> {
    await this.access.administrator(AbortSignal.any([signal, this.lifetime.signal]))
    const owner = [...this.owners.values()].find(owner => owner.managementId === ownerId)
    if (owner !== undefined) await this.closeOwned(owner, id)
  }

  /**
   * Await or retry cleanup only for owners whose authority has already ended.
   * This lifecycle operation never exposes output or opens a new process.
   * @returns after every stopping owner has released its subprocess resources.
   */
  async drainRevoked(): Promise<void> {
    const results = await Promise.allSettled([...this.owners].filter(([, owner]) => owner.lifetime.signal.aborted)
      .map(([key, owner]) => this.disposeOwner(key, owner)))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Revoked terminal cleanup is incomplete')
  }

  private ownerKey(id: SessionId, creator: TerminalCreatorId): string { return JSON.stringify([id, creator]) }

  private owner(agent: Agent, authority: TerminalAuthority): OwnedSession {
    const key = this.ownerKey(agent.id, authority.creator)
    let owner = this.owners.get(key)
    if (owner === undefined) {
      authority.signal.throwIfAborted()
      const retained = authority.retain()
      const revoked = () => {
        const task = this.disposeOwner(key, owned)
        this.cleanupTasks.add(task)
        void task.catch((error: unknown) => { this.ctx.logger.error('Revoked user terminal cleanup failed', error) })
          .finally(() => { this.cleanupTasks.delete(task) })
      }
      owner = { managementId: randomUUID() as TerminalOwnerId, sessionId: agent.id, ...(authority.creatorUserId === undefined ? {} : { creatorUserId: authority.creatorUserId }), creator: authority.creator, revoked: () => { authority.signal.removeEventListener('abort', revoked); retained[Symbol.dispose]() }, terminals: new Map(), pending: new Map(), allocations: new Map(), closedIds: new Set(), lifetime: new AbortController() }
      this.owners.set(key, owner)
      const owned = owner
      authority.signal.addEventListener('abort', revoked, { once: true })
      agent.ctx.effect(() => async () => { await this.disposeOwner(key, owned) }, 'terminal-controller.owner')
    }
    return owner
  }

  private disposeOwner(id: string, owner: OwnedSession): Promise<void> {
    if (owner.cleanup !== undefined) return owner.cleanup
    owner.lifetime.abort(new Error('Terminal Session owner disposed'))
    owner.cleanup = (async () => {
      await Promise.allSettled(owner.pending.values())
      const results = await Promise.allSettled([
        ...[...owner.terminals.values()].map(terminal => terminal.dispose()),
        ...[...owner.allocations.values()].map(allocation => allocation.cleanup.dispose()),
      ])
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (errors.length > 0) throw new AggregateError(errors, 'Session terminal cleanup failed')
      owner.terminals.clear()
      owner.allocations.clear()
      owner.revoked()
      this.owners.delete(id)
    })().catch((error: unknown) => { delete owner.cleanup; throw error })
    return owner.cleanup
  }

  private ownedTerminal(agent: Agent, id: WebTerminalId, creator: TerminalCreatorId): { owner: OwnedSession; terminal: BrowserTerminal } {
    const owner = this.owners.get(this.ownerKey(agent.id, creator))
    const terminal = owner?.terminals.get(id)
    if (owner === undefined || terminal === undefined) throw new RemoteError('terminal/unavailable', 'Terminal no longer exists in this Session', {})
    this.requireOpen(owner, id)
    return { owner, terminal }
  }

  private requireOpen(owner: OwnedSession, id: WebTerminalId): void {
    if (owner.lifetime.signal.aborted || owner.closedIds.has(id)) throw new RemoteError('terminal/unavailable', 'Terminal was closed in this Session', {})
  }

  private dimensions(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > this.config.maxCols
      || !Number.isSafeInteger(rows) || rows < 1 || rows > this.config.maxRows) throw new Error('Terminal dimensions exceed the configured limits')
  }

  private execution(agent: Agent): { subprocess: Context['subprocess']; sandboxPolicy: Context['sandboxPolicy'] } {
    // The Agent context selects execution providers but does not inject consumer services.
    const subprocess = agent.ctx.get('subprocess')
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')
    if (subprocess === undefined || sandboxPolicy === undefined) throw new Error('The Session execution environment requires subprocess and sandbox policy providers')
    return { subprocess, sandboxPolicy }
  }

  private async spawn(agent: Agent, owner: OwnedSession, request: TerminalCreateRequest, signal: AbortSignal): Promise<BrowserTerminal> {
    const environment = this.environmentOf(agent)
    const { subprocess } = this.execution(agent)
    const shell = request.shellPath === undefined
      ? await resolveShell(subprocess, this.config.shell, signal)
      : (await discoverShells(subprocess, this.config.shell, this.config.shellCandidates, signal))
        .find(candidate => candidate.path === request.shellPath)
    if (shell === undefined) throw new Error('Selected shell is not available in this execution environment')
    const handle = await subprocess.spawnTerminal({
      argv: [shell.path, ...shell.args], cwd: environment.cwd, cols: request.cols, rows: request.rows,
      terminalType: 'xterm-256color', env: { DSH_SESSION_ID: agent.id },
      shellActivity: true,
      graceMs: this.config.disposeGraceMs, signal,
    })
    const info: WebTerminalInfo = {
      id: request.id, shell, title: shell.name, cwd: environment.cwd,
      cols: request.cols, rows: request.rows, state: 'running', exitCode: null,
    }
    try {
      signal.throwIfAborted()
      return new BrowserTerminal(handle, info, this.config.scrollback, this.config.maxBufferedBytes)
    } catch (error) {
      const cleanup = new TerminalRetention(this.config, handle.inspectActivity.bind(handle), async () => {
        owner.closedIds.add(request.id)
        await handle.terminate()
        owner.allocations.delete(request.id)
      }, (cleanupError) => { this.ctx.logger.error('Browser terminal allocation cleanup failed', cleanupError) })
      owner.allocations.set(request.id, {
        info: { ...info, state: 'failed', error: error instanceof Error ? error.message : String(error) }, cleanup,
      })
      try {
        await cleanup.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Terminal allocation cleanup failed')
      }
      throw error
    }
  }
}

/** Browser terminal service plugin. */
export default TerminalController
