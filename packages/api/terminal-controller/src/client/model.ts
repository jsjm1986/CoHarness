/** React-free browser terminal state and reconnecting Remote-stream ownership. */
import { preferredShell, rememberShell } from './shell-preference.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { RemoteStreamCarrierError, type ClientRemote, type RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TerminalAttachmentId, TerminalEnvironment, TerminalFrame,
  WebTerminalId, WebTerminalInfo,
} from '../types.ts'
import {
  TerminalInputChannelClosedError,
  TerminalInputChannelUnavailableError,
  type TerminalInputChannel,
  type TerminalInputChannelFactory,
} from './input-channel.ts'

export type { TerminalInputChannel, TerminalInputChannelFactory, TerminalInputChannelTarget } from './input-channel.ts'

/** The generated terminal namespace's browser-facing operations. */
export type TerminalRemote = Pick<ClientRemote['terminal'], 'environment' | 'shells' | 'list' | 'create' | 'retain' | 'follow' | 'write' | 'resize' | 'rename' | 'close'>

/** Product error identifiers translated by the terminal UI. */
export type TerminalViewIssue = 'missingTerminal' | 'inputFull' | 'attachmentEnded' | 'invalidOutput' | 'terminalLimit' | 'forbidden'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Client terminal failure preserved through the Remote stream supervisor. */
    'terminal/view': { readonly issue: TerminalViewIssue }
  }
}

class TerminalViewError extends RemoteError<'terminal/view'> {
  constructor(issue: TerminalViewIssue, message: string = issue) { super('terminal/view', message, { issue }) }
}

/**
 * Classify a terminal failure into the product issue the UI translates.
 * `terminal/forbidden` is a permission denial the caller cannot fix by
 * retrying, so its surfaces must not offer an unchanged-retry action.
 * @param error - rejection from a terminal Remote call or stream.
 * @returns the translatable issue, or undefined for unclassified failures.
 */
export function terminalIssueOf(error: unknown): TerminalViewIssue | undefined {
  const failure = remoteErrorOf(error)
  if (failure?.code === 'terminal/view') return failure.details.issue
  if (failure?.code === 'terminal/limit-reached') return 'terminalLimit'
  if (failure?.code === 'terminal/forbidden') return 'forbidden'
  if (failure?.code === 'terminal/unavailable') return 'missingTerminal'
  return undefined
}

/** One screen write awaiting the DOM emulator's callback. */
export interface TerminalRenderFrame {
  readonly revision: number
  readonly frame: Extract<TerminalFrame, { type: 'snapshot' | 'output' }>
}

/** Observable state of one sidebar occurrence. */
export interface TerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly environment?: TerminalEnvironment | undefined
  readonly title?: string | undefined
  readonly info?: WebTerminalInfo | undefined
  readonly writable: boolean
  readonly render?: TerminalRenderFrame | undefined
  readonly error?: string | undefined
  readonly issue?: TerminalViewIssue | undefined
}

const MAX_INPUT_RECONNECT_ATTEMPTS = 5
const MAX_INPUT_RECONNECT_DELAY_MS = 30_000

/** A view survives DOM unmount; its process only ends on explicit close. */
export class TerminalView {
  /** Observable controls, process metadata and the next screen update awaiting acknowledgement. */
  readonly state: SnapshotStore<TerminalViewState> = createSnapshotStore<TerminalViewState>({ phase: 'idle', writable: false })
  private readonly lifetime = new AbortController()
  private readonly encoder = new TextEncoder()
  private stream: RemoteStream<TerminalFrame> | undefined
  private mounted = false
  private attachmentId: TerminalAttachmentId | undefined
  private pendingRender: { revision: number; resolve: () => void } | undefined
  private revision = 0
  private creation: Promise<void> | undefined
  private loading: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private writes: Promise<void> = Promise.resolve()
  private queuedInput = 0
  private pendingInput: { attachmentId: TerminalAttachmentId; data: string; bytes: number } | undefined
  private latestResize: { attachmentId: TerminalAttachmentId; cols: number; rows: number; replaceable: boolean } | undefined
  private inputChannel: { attachmentId: TerminalAttachmentId; channel: TerminalInputChannel } | undefined
  private inputReconnectTimer: ReturnType<typeof setTimeout> | undefined
  private inputReconnectAttempts = 0
  private readonly detaching = new Set<Promise<void>>()

  /**
   * @param sessionId - Session owning the terminal.
   * @param remote - typed terminal Remote operations.
   * @param gateway - reconnecting stream factory.
   * @param id - Host terminal identity, reused when recovering an item from its Session list.
   * @param createWhenMissing - allow allocation only for a new tab, never a listed terminal.
   * @param shellPath - explicit shell chosen at the guide; omission uses the remembered available shell.
   * @param retain - window hold acknowledgement required before output attachment.
   * @param preferenceKey - verified persistence identity; omission disables saved shell preferences.
   * @param openInputChannel - optional low-latency bidirectional WebSocket input channel factory.
   * @param inputReconnectDelayMs - delay before re-opening a dropped input WebSocket while writable.
   */
  constructor(
    private readonly sessionId: SessionId,
    private readonly remote: TerminalRemote,
    private readonly gateway: Pick<ClientRemote, '$stream'>,
    readonly id: WebTerminalId,
    private readonly createWhenMissing = true,
    private readonly shellPath?: string,
    private readonly retain?: (signal: AbortSignal) => Promise<void>,
    private readonly preferenceKey?: string,
    private readonly openInputChannel?: TerminalInputChannelFactory,
    private readonly inputReconnectDelayMs = 2_000,
  ) {}

  /**
   * Attach the DOM lifetime, starting the chosen shell or reconnecting the saved process.
   * @returns a detach callback that leaves the terminal process alive.
   */
  mount(): () => void {
    this.mounted = true
    if (this.state.getSnapshot().info === undefined) void this.refresh()
    else this.connect()
    return () => {
      this.mounted = false
      this.detach()
    }
  }

  /**
   * Start or recover this tab, deduplicating mounts and retries during allocation.
   * Only a new tab may allocate a shell; listed terminals cannot be silently replaced.
   * @returns after environment lookup and creation or recovery settle.
   */
  refresh(): Promise<void> {
    if (this.creation !== undefined) return this.creation
    if (this.loading !== undefined) return this.loading
    if (this.closing !== undefined || this.lifetime.signal.aborted) return Promise.resolve()
    this.patch({ phase: 'loading', error: undefined, issue: undefined })
    this.loading = (async () => {
      // Overlap default shell discovery with environment/list lookup so opening a new tab saves one round trip.
      const shellDiscovery = this.createWhenMissing && this.shellPath === undefined
        ? new AbortController()
        : undefined
      const speculativeShells = shellDiscovery === undefined
        ? undefined
        : Promise.resolve().then(() => this.remote.shells(
          this.sessionId,
          AbortSignal.any([this.lifetime.signal, shellDiscovery.signal]),
        )).then(
          result => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      try {
        const [environment, available] = await Promise.all([
          this.remote.environment(this.sessionId, this.lifetime.signal), this.remote.list(this.sessionId),
        ])
        if (this.stopped()) return
        this.patch({ environment: valueOf(environment) })
        const info = valueOf(available).find(item => item.id === this.id)
        if (info !== undefined) {
          shellDiscovery?.abort()
          this.adopt(info)
        } else if (this.createWhenMissing) {
          let path = this.shellPath
          if (path === undefined && speculativeShells !== undefined) {
            const settled = await speculativeShells
            if (!settled.ok) throw settled.error
            const shells = valueOf(settled.result)
            const previous = preferredShell(this.preferenceKey)
            path = shells.find(shell => shell.path === previous)?.path ?? shells[0]?.path
          }
          if (this.stopped()) return
          if (path !== undefined) rememberShell(this.preferenceKey, path)
          await this.create(valueOf(environment), path)
        }
        else throw new TerminalViewError('missingTerminal')
      } finally {
        shellDiscovery?.abort()
      }
    })().catch((error: unknown) => { if (!this.stopped()) this.fail(error) }).finally(() => { this.loading = undefined })
    return this.loading
  }

  private stopped(): boolean { return this.lifetime.signal.aborted || this.closing !== undefined }

  private async create(environment: TerminalEnvironment, shellPath?: string): Promise<void> {
    this.patch({ phase: 'creating', error: undefined, issue: undefined })
    this.creation = (async () => {
      const info = valueOf(await this.remote.create(this.sessionId, {
        id: this.id, ...shellPath === undefined ? {} : { shellPath },
        cols: Math.min(80, environment.maxCols), rows: Math.min(24, environment.maxRows),
      }, this.lifetime.signal))
      if (!this.lifetime.signal.aborted) {
        this.adopt(info)
      }
    })().catch((error: unknown) => { this.fail(error) }).finally(() => { this.creation = undefined })
    await this.creation
  }

  private adopt(info: WebTerminalInfo): void {
    this.patch({ info, title: info.title })
    if (this.retain === undefined) { if (this.mounted && this.closing === undefined) this.connect(); return }
    void this.retain(this.lifetime.signal).then(() => {
      if (this.mounted && this.closing === undefined) this.connect()
    }).catch((error: unknown) => { if (!this.stopped()) this.fail(error) })
  }

  /** Reattach with a fresh screen and regain input control. */
  connect(): void {
    const info = this.state.getSnapshot().info
    if (info === undefined || !this.mounted || this.closing !== undefined || this.lifetime.signal.aborted) return
    this.detach()
    const stream = this.gateway.$stream<TerminalFrame>({
      sessionId: this.sessionId,
      name: 'Browser terminal output',
      open: async function* (this: TerminalView, signal: AbortSignal) {
        await this.retain?.(signal)
        signal.throwIfAborted()
        const attachmentId = randomUUID() as TerminalAttachmentId
        this.attachmentId = attachmentId
        yield* this.remote.follow(this.sessionId, info.id, attachmentId, signal)
      }.bind(this),
      ended: () => new TerminalViewError('attachmentEnded'),
      carrierFailed: () => {
        if (this.stream === stream) {
          this.dropInputChannel()
          this.patch({ phase: 'disconnected', writable: false })
        }
      },
    })
    this.stream = stream
    this.patch({ phase: 'connecting', writable: false, error: undefined, issue: undefined, render: undefined })
    void this.consume(stream)
  }

  /**
   * Release the next stream item after xterm has parsed this frame.
   * @param revision - locally delivered render revision.
   */
  acknowledge(revision: number): void {
    if (this.pendingRender?.revision !== revision) return
    this.pendingRender.resolve()
    this.pendingRender = undefined
  }

  /**
   * Serialize raw input and coalesce adjacent queued keystrokes for one attachment.
   * A resize or attachment change ends the batch; UTF-8 limits include in-flight input.
   * @param data - input from the terminal emulator.
   */
  write(data: string): void {
    const state = this.state.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || state.info === undefined || attachmentId === undefined) return
    const bytes = this.encoder.encode(data).byteLength
    if (this.queuedInput + bytes > (state.environment?.maxInputBytes ?? 0)) { this.fail(new TerminalViewError('inputFull')); return }
    if (this.latestResize !== undefined) this.latestResize.replaceable = false
    this.queuedInput += bytes
    if (this.pendingInput?.attachmentId === attachmentId) {
      this.pendingInput.data += data
      this.pendingInput.bytes += bytes
      return
    }
    const input = { attachmentId, data, bytes }
    this.pendingInput = input
    const id = state.info.id
    this.writes = this.writes.then(async () => {
      if (this.pendingInput === input) this.pendingInput = undefined
      if (this.attachmentId !== attachmentId || !this.state.getSnapshot().writable) return
      const channel = this.inputChannel?.attachmentId === attachmentId ? this.inputChannel.channel : undefined
      if (channel?.isOpen) {
        try {
          await channel.write(input.data)
          this.inputReconnectAttempts = 0
          return
        } catch (error) {
          const sent = error instanceof TerminalInputChannelClosedError
          if (!sent && !(error instanceof TerminalInputChannelUnavailableError)) throw error
          if (this.inputChannel?.channel === channel) {
            this.dropInputChannel()
            this.scheduleInputChannelReconnect(id, attachmentId)
          }
          if (sent) return
        }
      }
      valueOf(await this.remote.write(this.sessionId, id, attachmentId, input.data))
    }).catch((error: unknown) => { if (this.attachmentId === attachmentId) this.fail(error) })
      .finally(() => { this.queuedInput -= input.bytes })
  }

  /**
   * Adjacent unsent resizes share the latest dimensions. Input and in-flight resizes retain their order.
   * @param cols - measured column count.
   * @param rows - measured row count.
   */
  resize(cols: number, rows: number): void {
    const state = this.state.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || state.info === undefined || attachmentId === undefined) return
    cols = Math.min(cols, state.environment?.maxCols ?? cols)
    rows = Math.min(rows, state.environment?.maxRows ?? rows)
    const previous = this.latestResize?.attachmentId === attachmentId ? this.latestResize : undefined
    const size = previous ?? state.info
    if (size.cols === cols && size.rows === rows) return
    this.pendingInput = undefined
    if (previous?.replaceable) {
      previous.cols = cols
      previous.rows = rows
      return
    }
    const resize = { attachmentId, cols, rows, replaceable: true }
    this.latestResize = resize
    const id = state.info.id
    this.writes = this.writes.then(async () => {
      resize.replaceable = false
      if (this.attachmentId !== attachmentId || !this.state.getSnapshot().writable) return
      const channel = this.inputChannel?.attachmentId === attachmentId ? this.inputChannel.channel : undefined
      if (channel?.isOpen) {
        try {
          await channel.resize(resize.cols, resize.rows)
          this.inputReconnectAttempts = 0
          return
        } catch (error) {
          if (error instanceof TerminalInputChannelClosedError || error instanceof TerminalInputChannelUnavailableError) {
            if (this.inputChannel?.channel === channel) {
              this.dropInputChannel()
              this.scheduleInputChannelReconnect(id, attachmentId)
            }
          } else {
            throw error
          }
        }
      }
      valueOf(await this.remote.resize(this.sessionId, id, attachmentId, resize.cols, resize.rows))
    }).catch((error: unknown) => { if (this.attachmentId === attachmentId) this.fail(error) })
  }

  /**
   * Update the Host terminal's display name.
   * @param title - user-entered terminal title.
   * @returns after the rename settles and its result is reflected in view state.
   */
  async rename(title: string): Promise<void> {
    if (title.trim() === this.state.getSnapshot().title || this.lifetime.signal.aborted) return
    try {
      valueOf(await this.remote.rename(this.sessionId, this.id, title))
      const current = this.state.getSnapshot().info
      this.patch({ ...(current === undefined ? {} : { info: { ...current, title: title.trim() } }), title: title.trim() })
    } catch (error) { this.fail(error) }
  }

  /**
   * Explicitly terminate this view's process independently of its DOM lifetime.
   * @returns after Host process cleanup succeeds; failures remain retryable by the owner.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.patch({ phase: 'closing', writable: false, error: undefined, issue: undefined })
    this.detach()
    this.closing = (async () => {
      // Even a refused or lost creation response may leave an allocation to close.
      await this.creation
      valueOf(await this.remote.close(this.sessionId, this.id))
      this.detach()
      this.patch({ phase: 'closed', writable: false })
    })().catch((error: unknown) => { this.closing = undefined; this.fail(error); throw error })
    return this.closing
  }

  /**
   * Stop Client work on plugin unload without closing Host terminals.
   * @returns after active and previously detached stream iterators have closed.
   */
  async dispose(): Promise<void> {
    this.mounted = false
    this.lifetime.abort()
    this.state.set({ phase: 'closed', writable: false })
    this.detach()
    await Promise.all(this.detaching)
  }

  private detach(): void {
    const previous = this.stream
    this.stream = undefined
    this.attachmentId = undefined
    this.pendingInput = undefined
    this.latestResize = undefined
    this.inputReconnectAttempts = 0
    this.dropInputChannel()
    this.pendingRender?.resolve()
    this.pendingRender = undefined
    if (previous !== undefined) {
      const cleanup = previous.dispose().finally(() => { this.detaching.delete(cleanup) })
      this.detaching.add(cleanup)
    }
  }

  private ensureInputChannel(terminalId: WebTerminalId, attachmentId: TerminalAttachmentId): void {
    if (this.openInputChannel === undefined || this.stopped()) return
    if (this.inputChannel?.attachmentId === attachmentId) return
    this.dropInputChannel()
    const channel = this.openInputChannel({ sessionId: this.sessionId, terminalId, attachmentId })
    if (channel === undefined) return
    this.inputChannel = { attachmentId, channel }
    const disconnected = (): void => {
      if (this.inputChannel?.channel !== channel) return
      this.inputChannel = undefined
      this.scheduleInputChannelReconnect(terminalId, attachmentId)
    }
    channel.signal?.addEventListener('abort', disconnected, { once: true })
    if (channel.signal?.aborted === true) disconnected()
  }

  private scheduleInputChannelReconnect(terminalId: WebTerminalId, attachmentId: TerminalAttachmentId): void {
    if (this.inputReconnectAttempts >= MAX_INPUT_RECONNECT_ATTEMPTS) return
    const attempt = this.inputReconnectAttempts++
    const delayMs = Math.min(MAX_INPUT_RECONNECT_DELAY_MS, this.inputReconnectDelayMs * (2 ** attempt))
    this.inputReconnectTimer = setTimeout(() => {
      this.inputReconnectTimer = undefined
      if (this.attachmentId !== attachmentId || !this.state.getSnapshot().writable || this.stopped()) return
      this.ensureInputChannel(terminalId, attachmentId)
    }, delayMs)
  }

  private dropInputChannel(): void {
    if (this.inputReconnectTimer !== undefined) {
      clearTimeout(this.inputReconnectTimer)
      this.inputReconnectTimer = undefined
    }
    if (this.inputChannel === undefined) return
    const current = this.inputChannel
    this.inputChannel = undefined
    current.channel.close()
  }

  private async consume(stream: RemoteStream<TerminalFrame>): Promise<void> {
    let generation = 0
    let sequence = 0
    try {
      for await (const item of stream) {
        if (this.stream !== stream) return
        const frame = item.value
        if (generation !== item.generation) {
          if (frame.type !== 'snapshot') throw new TerminalViewError('invalidOutput', 'Terminal output generation is missing its screen snapshot')
          generation = item.generation
          sequence = frame.sequence
          item.accept()
        } else if (frame.type === 'output') {
          if (frame.sequence !== sequence + 1) throw new TerminalViewError('invalidOutput', 'Terminal output sequence has a gap')
          sequence = frame.sequence
        } else if (frame.type === 'snapshot') throw new TerminalViewError('invalidOutput', 'Unexpected terminal screen snapshot')
        if (frame.type !== 'output') {
          const writable = frame.info.state === 'running' && frame.info.controllerId === this.attachmentId
          this.patch({ info: frame.info, title: frame.info.title, phase: 'connected', writable })
          if (writable && this.attachmentId !== undefined) this.ensureInputChannel(frame.info.id, this.attachmentId)
          else this.dropInputChannel()
        }
        if (frame.type !== 'state') {
          const revision = ++this.revision
          await new Promise<void>((resolve) => {
            this.pendingRender = { revision, resolve }
            const aborted = (): void => { this.acknowledge(revision) }
            item.signal.addEventListener('abort', aborted, { once: true })
            this.pendingRender.resolve = () => { item.signal.removeEventListener('abort', aborted); resolve() }
            this.patch({ render: { revision, frame } })
            if (item.signal.aborted) aborted()
          })
        }
      }
    } catch (error) {
      if (this.stream === stream) {
        if (this.state.getSnapshot().info?.state === 'exited') this.patch({ phase: 'closed', writable: false })
        else this.fail(error)
      }
    }
  }

  private patch(patch: Partial<TerminalViewState>): void {
    if (this.lifetime.signal.aborted) return
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }

  private fail(error: unknown): void {
    this.dropInputChannel()
    const failure = remoteErrorOf(error)
    if (failure?.code === 'terminal/control-unavailable') {
      this.patch({ writable: false, error: undefined, issue: undefined })
      return
    }
    if (failure?.code === 'terminal/forbidden') this.patch({ render: undefined, info: undefined, title: undefined, environment: undefined })
    const issue = terminalIssueOf(error)
    this.patch({ phase: error instanceof RemoteStreamCarrierError ? 'disconnected' : 'failed', writable: false, issue, error: error instanceof Error ? error.message : String(error) })
  }
}

function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
