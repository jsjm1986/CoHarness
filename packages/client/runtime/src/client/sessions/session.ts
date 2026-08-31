// Sessions remain resident after creation so they continue consuming mux frames
// off-screen; their browser history window is staged and released separately.

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { hasConversationContent as hasSessionConversationContent } from '@deepseek-ai/dsh-session/surface'
import type {
  HistoryEntry, HistoryOmittedSpan, IApiClient, MessageId, MuxFrame, PromptContentPart, QueueAction, RpcError,
  RpcId, RpcResponse, RpcResult, SessionId, SubagentAddress, ToolEventView,
} from '@deepseek-ai/dsh-api-remotes/client'
// Value import from the inline-safe wire layer (not the connection plugin):
// plugin-to-plugin value imports are a bundle purity error.
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, SessionFace, SubmissionHandle,
} from '../contract/session.ts'
import { ConversationNodeAssembler } from './conversation-assembler.ts'
import type { ConversationRuntime } from './conversation-assembler.ts'
import type { ConversationEventInput, ConversationPublication } from '../contract/conversation.ts'
import type {
  ChatSnapshot, ComposerPhase, ConversationSnapshot, HistoryDetailState, HistoryWindowMode, OpenState, PendingSubmission, PromptError,
} from './conversation.ts'
import { EMPTY_CHAT_SNAPSHOT } from './conversation.ts'
import type { PendingInteraction } from './pending.ts'
import { PendingWait } from './pending.ts'
import { Notifier } from './notifier.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemotes } from './remotes.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
import { resolvedClientTimeZone } from '../time-zone.ts'
import { SessionQueueMirror } from './queue-mirror.ts'

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Safety bound for one background history expansion. */
const MAX_HISTORY_EXPANSION_PAGES = 64

/** One validated history page used by window mutations. */
interface HistoryPage {
  entries: HistoryEntry[]
  hasMore: boolean
  projections?: ProjectionsBaseline
  omittedSpans: HistoryOmittedSpan[]
}

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /** Whether the exact direct parent Agent was live at the latest catalog read. */
  parentAvailable?: boolean
  /** Notify the manager after a visible conversation event is observed. */
  onEngaged?(session: Session, visibleContentSeq: number): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
  /** Runtime registries used by this Session-owned Conversation assembler. */
  conversation?: ConversationRuntime
}

/**
 * Whether one persisted event contributes a non-empty model-visible message.
 * Empty turns and usage-only assistant messages must not create a sidebar row.
 * @param event - session event from history or the live mux stream.
 * @returns true when the event contains conversation content.
 */
export function hasConversationContent(event: SessionEvent): boolean {
  return hasSessionConversationContent(event)
}

/**
 * Owns a session's event window, derived conversation state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are manager/runtime entry points.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  private events: SessionEvent[] = []
  /** Wire views aligned with `events` by index (envelope-level annotations; undefined = no view).
   *  Kept parallel rather than merged so `events` stays the raw log slice (model-visible ⟺ logged). */
  private views: (ToolEventView | undefined)[] = []
  private baseSeq = 0
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RpcError | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by resync to invalidate an in-flight doOpen: a reconnect must rebuild, never adopt
   *  a pre-disconnect open whose history request is already doomed. Stale doOpen
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  /** Whether this Session is currently the staged conversation surface. */
  private stageActive = false
  /** Tail → background expansion → retained live history lifecycle. */
  private historyWindowMode: HistoryWindowMode = 'tail'
  /** One serialized history mutation; detail fills and older-page reads share it. */
  private historyOperation: Promise<void> | null = null
  private historyExpansionPromise: Promise<void> | null = null
  private historyAbortController: AbortController | null = null
  /** Inclusive seq ranges of omitted historical chunks; part of the logical window. */
  private omittedSpans: HistoryOmittedSpan[] = []
  /**
   * Download gear: Web open/loadOlder stay `'conversation'` until Trajectory
   * fill succeeds, then `'full'` so later pages include chunks.
   */
  private historyDetail: HistoryDetailState = 'conversation'
  private fillPromise: Promise<void> | null = null
  private pending = new Map<string, PendingInteraction>()
  private pendingRev = 0
  private pendingCache: { rev: number; value: PendingInteraction[] } | null = null
  /** Authoritative stream-only inbox snapshot; pending work never hits history. */
  private readonly queueMirror = new SessionQueueMirror()
  /** Session-owned business Context engine over the contiguous raw window. */
  private readonly conversation: ConversationNodeAssembler
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable = false
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * synchronously before prompt()'s first await, never reset — the blank →
   * engaging edge of the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  /** No-visible-content mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
  private blankBit = true
  /** Durable evidence that this Session has emitted visible conversation content. */
  private conversationContentObserved = false
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Live events buffered during open/resync and stitched by sequence once history lands. */
  private liveBuffer: { event: SessionEvent; view: ToolEventView | undefined }[] = []
  /** Gap repair in flight; live events detour to the buffer until the tail page lands. */
  private stitching = false
  /** subscribed.lastSeq baseline (gap detection; null when no subscribed frame arrived — degrade to the liveBuffer dedup path). */
  private subscribedLastSeq: number | null = null
  /** Local submission echoes retained until their durable event or queue occurrence is observed. */
  private pendingSubmissions: readonly PendingSubmission[] = []
  /** Settlement latches prevent queue and durable observations retiring one echo twice. */
  private readonly submissionSettlements = new Map<RpcId, {
    readonly onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined
    retiring: boolean
  }>()

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the host, seeded by the tail page's
   * projections block and updated by `session/projection` frames under the
   * one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  private snapshotCache: ConversationSnapshot
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by SessionRuntime when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param api - shared wire client.
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly api: IApiClient,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.address = options.address
    this.parentAvailable = options.parentAvailable ?? false
    this.conversation = options.conversation === undefined
      ? new ConversationNodeAssembler(
        { entries: () => [], fallbackEntry: () => undefined },
        { entries: () => [] },
      )
      : new ConversationNodeAssembler(options.conversation.events, options.conversation.views)
    this.notifier = new Notifier(() => {
      this.conversation.flush()
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Bind the Agent-scoped context minted by SessionRuntime (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  /**
   * Mark this Session as the staged conversation surface. Re-entering an idle
   * session keeps the bounded tail; an already-running session starts the
   * background expansion after its tail is open.
   */
  enterStage(): void {
    if (this.stageActive) return
    this.stageActive = true
    if (this.openState !== 'open') void this.open()
    if (this.running) this.beginLiveHistory()
    else this.notifier.markDirty()
  }

  /**
   * Release the browser history window when the user leaves this Session.
   * Pending stream state, projections, and interactions stay resident; the
   * next stage entry reads a fresh tail and cannot adopt an old request.
   */
  leaveStage(): void {
    if (!this.stageActive) return
    this.stageActive = false
    this.openGeneration++
    this.historyAbortController?.abort()
    this.historyAbortController = null
    this.historyExpansionPromise = null
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.events = []
    this.views = []
    this.omittedSpans = []
    this.baseSeq = 0
    this.hasMore = false
    this.loadingOlder = false
    this.historyDetail = 'conversation'
    this.historyWindowMode = 'tail'
    this.liveBuffer = []
    this.stitching = false
    this.conversation.replaceWindow([], false)
    this.notifier.markDirty()
  }

  // ---- Operations ----

  /**
   * Register one local submission echo before serialization and transport.
   * @param input - echo text, image previews, and settlement callback.
   * @returns prompt identity plus a pre-admission abandon operation.
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    const requestId = randomUUID() as RpcId
    this.pendingSubmissions = [...this.pendingSubmissions, {
      requestId,
      time: Date.now(),
      text: input.text,
      images: input.images,
    }]
    this.submissionSettlements.set(requestId, { onRetire: input.onRetire, retiring: false })
    this.promptAttempted = true
    this.notifier.markDirty()
    return {
      requestId,
      abandon: () => { this.retireFailedSubmission(requestId) },
    }
  }

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
   * @param content - text plus browser-owned temporary image uploads.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  async prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: RpcId,
  ): Promise<RpcResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Synchronous, before the first await: the blank → engaging edge must be
    // visible on the session area's very first frame when a caller sends
    // ahead of navigation (first-send flow).
    this.promptAttempted = true
    if (this.blankBit) this.firstPromptPendingTurn = true
    this.notifier.markDirty()
    let result: RpcResult<{ accepted: true }>
    try {
      if (this.address === undefined) {
        result = (await this.api.sessions.prompt({
          sessionId: this.sessionId,
          mode,
          content,
          clientTimeZone: resolvedClientTimeZone(),
          ...(requestId === undefined ? {} : { requestId }),
        }, signal)).result
      } else if (this.address.mode === 'one-shot') {
        result = {
          ok: false,
          error: {
            code: 'subagent-not-resumable',
            message: 'one-shot subagent conversations are read-only',
            details: { childSessionId: this.address.childSessionId },
          },
        }
      } else {
        if (content.some(part => part.type === 'image')) {
          result = {
            ok: false,
            error: {
              code: 'attachment-error',
              message: 'Image input is unavailable for subagent continuations.',
              details: { reason: 'SUBAGENT_IMAGE_UNSUPPORTED' },
            },
          }
        } else {
          const routed = (await this.api.subagents.prompt({
            ...this.address,
            ...(requestId === undefined ? {} : { requestId }),
            content: content.flatMap(part => part.type === 'text'
              ? [{ type: 'text' as const, text: part.text }]
              : []),
            clientTimeZone: resolvedClientTimeZone(),
          }, signal)).result
          result = routed.ok ? { ok: true, value: { accepted: true } } : routed
        }
      }
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      if (requestId !== undefined) this.retireFailedSubmission(requestId)
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // Acceptance only means the Host admitted a turn. The pre-step pipeline
    // may still reject or empty it, so blankness changes when a visible event
    // actually arrives rather than at the RPC response.
    this.beginLiveHistory()
    return result
  }

  /**
   * Resolve one image referenced by this session into browser-consumable bytes.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    try {
      const result = (await this.api.sessions.attachment({
        sessionId: this.sessionId,
        attachmentId,
      })).result
      if (!result.ok) return result
      const binary = atob(result.value.data)
      const data = Uint8Array.from(binary, char => char.charCodeAt(0))
      return { ok: true, value: { attachment: result.value.attachment, data } }
    } catch (error) {
      return transportError(error)
    }
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>> {
    try {
      return (await this.api.sessions.updateQueue({ sessionId: this.sessionId, itemId, action })).result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Stop the active turn while the Host preserves pending inbox work; failures
   * land in promptError (same error-strip display slot). A continuable
   * subagent address routes through `subagent.interrupt`, whose durable
   * parent-address authority works without a live parent Agent; a one-shot
   * address stays uncancellable (the UI offers no stop action, so this arm is
   * defensive).
   * @returns the cancel result.
   */
  async cancel(): Promise<RpcResult<{ accepted: true }>> {
    const address = this.address
    if (address !== undefined && address.mode === 'one-shot') {
      const result: RpcResult<{ accepted: true }> = {
        ok: false,
        error: {
          code: 'subagent-delivery-unavailable',
          message: 'subagent activation cancellation is unavailable',
          details: { childSessionId: address.childSessionId },
        },
      }
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
      return result
    }
    let result: RpcResult<{ accepted: true }>
    try {
      result = address !== undefined
        ? (await this.api.subagents.interrupt(address)).result
        : (await this.api.sessions.cancel({ sessionId: this.sessionId })).result
    } catch (error) {
      result = transportError(error)
    }
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the mux frame.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  async rename(title: string): Promise<RpcResult<{ title: string; seq: number }>> {
    try {
      const { result } = await this.api.sessions.rename({ sessionId: this.sessionId, title })
      if (result.ok) this.projections.apply('title', result.value.title, result.value.seq)
      return result
    } catch (error) {
      return transportError(error)
    }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the error branch on transport failure.
   */
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    if (!result.ok) return result
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    const generation = this.openGeneration
    try {
      await this.enqueueHistoryOperation(async (signal) => {
        if (generation !== this.openGeneration || this.openState !== 'open' || !this.hasMore) return
        const page = await this.fetchHistoryPage({ beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES }, signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stage leave/resync can supersede the awaited page.
        if (page === undefined || generation !== this.openGeneration || this.openState !== 'open') return // keep the window as-is; open already succeeded
        this.applyOlderPage(page)
      }, true)
    } catch (error) {
      console.error('[web-runtime] loadOlder failed:', error)
    }
  }

  /**
   * Download omitted historical chunks for the installed window. Idempotent
   * once `historyDetail` is `'full'`.
   * @returns when fill settles or is already complete.
   */
  async ensureHistoryDetail(): Promise<void> {
    if (this.historyDetail === 'full') return
    if (this.fillPromise !== null) return this.fillPromise
    if (this.openState !== 'open') await this.open()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- another caller can start the fill while open() yields.
    if (this.fillPromise !== null) return this.fillPromise
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- open() can settle the mutable detail state while awaited.
    if (this.historyDetail !== 'conversation' && this.historyDetail !== 'filling') return
    const generation = this.openGeneration
    const promise = this.enqueueHistoryOperation(async (signal) => {
      // The operation may have waited behind an older page. Do not start a
      // detail fill after the owning Session scope has been disposed or
      // superseded during that wait.
      if (generation !== this.openGeneration || this.openState !== 'open') return
      await this.fillHistoryDetail(signal)
    }, false)
    this.fillPromise = promise
    try {
      await promise
    } finally {
      if (this.fillPromise === promise) this.fillPromise = null
    }
  }

  /** Reconnect rebuild (manager calls this on onConnected for instances that were opened):
   *  reset the window and rerun open; pending waits for the baseline replay. Invalidates any
   *  in-flight open first — its history request rode the dead connection and must not settle
   *  the fresh generation into 'error'. */
  async resync(): Promise<void> {
    // The queue mirror is NOT cleared here: onConnected (which drives resync)
    // races the mux frames — the fresh generation's baseline may have landed
    // already, and the host never resends it. The mirror re-baselines on the
    // session/subscribed frame instead (same stream as the queue snapshot
    // that follows it, so ordering is guaranteed).
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    this.openGeneration++
    this.historyAbortController?.abort()
    this.historyAbortController = null
    this.historyExpansionPromise = null
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.events = []
    this.views = []
    this.omittedSpans = []
    this.baseSeq = 0
    if (this.historyDetail !== 'conversation') this.historyDetail = 'full'
    this.fillPromise = null
    // Superseded, not settled: the baseline replay re-sends still-pending requested frames verbatim
    // (same rpcId), re-minting fresh waits; a stale reference's respond() still reaches the host.
    this.pending.clear()
    this.pendingRev++
    this.subscribedLastSeq = null
    this.liveBuffer = []
    this.historyWindowMode = 'tail'
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached conversation snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): ConversationSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Mux frame arrival (the dispatch switch).
   * @param rpcId - the frame envelope id (the respond backfill key for requested frames).
   * @param frame - the routed frame.
   */
  handleMuxEnvelope(rpcId: RpcId, frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/event': {
        this.acceptLiveEvent(frame.event, frame.view)
        return
      }
      case 'session/queue': {
        this.queueMirror.replace(frame.items)
        this.observeSubmissionQueue(frame.items)
        this.notifier.markDirty()
        return
      }
      case 'session/subscribed': {
        this.subscribedLastSeq = frame.lastSeq
        // New mux-generation baseline: the host pushes this session's queue
        // snapshot AFTER the subscribed frame on the same stream, so the
        // stale mirror clears here — race-free against onConnected/resync
        // timing (clearing there could wipe a baseline that already landed).
        if (this.queueMirror.reset()) this.notifier.markDirty()
        return
      }
      case 'approval/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('approval', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'approval/resolved': {
        for (const item of this.pending.values()) {
          if (item.kind === 'approval' && item.payload.approvalId === frame.approvalId) this.settle(item)
        }
        this.notifier.markDirty()
        return
      }
      case 'question/requested': {
        const { type: _type, sessionId: _sid, ...payload } = frame
        this.mint(new PendingWait('question', rpcId, this.sessionId, payload, m => this.api.respond(m)))
        this.notifier.markDirty()
        return
      }
      case 'question/resolved': {
        const item = this.pending.get(`q:${frame.questionRpcId}`)
        if (item !== undefined) this.settle(item)
        this.notifier.markDirty()
        return
      }
      default:
        return // stream/error never reaches Session (Controller converges it); unknown frames ignored (documented default)
    }
  }

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    if (running) this.beginLiveHistory()
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   * @param parentAvailable - latest exact-parent availability hint.
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable = false): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Update only the parent availability hint from a catalog refresh.
   * @param available - whether the exact direct parent is live.
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * Blank-bit relay from the authoritative summary source (list baseline and
   * the session-added frame). A stale true cannot re-blank after a visible
   * conversation event has been observed locally.
   * @param blank - the summary's derived no-visible-content bit.
   */
  handleBlank(blank: boolean): void {
    if (!blank) this.conversationContentObserved = true
    if (blank === this.blankBit) return
    if (blank && this.conversationContentObserved) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** host/session-removed relay: flag the snapshot (instance survives — resident-instance rule). */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * host/agent-error relay: the only outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /** Stop in-flight history work and release submission observers for this scope. */
  dispose(): void {
    this.openGeneration++
    this.historyAbortController?.abort(new Error('session disposed'))
    this.historyAbortController = null
    this.historyExpansionPromise = null
    this.openPromise = null
    this.fillPromise = null
    for (const requestId of [...this.submissionSettlements.keys()]) {
      this.retireFailedSubmission(requestId)
    }
  }

  /** Rebuild the current window after a low-frequency Definition or view registration change. */
  rebuildConversationRegistry(): void {
    this.scheduleConversation(this.conversation.rebuildRegistry())
  }

  // ---- Private ----

  /** Requested-frame arrival: the wait enters the pending map under its own key. */
  private mint(wait: PendingInteraction): void {
    this.pending.set(wait.key, wait)
    this.pendingRev++
  }

  /** Authoritative resolved-frame settlement: mark, then drop from the pending map. */
  private settle(wait: PendingInteraction): void {
    wait.markSettled()
    this.pending.delete(wait.key)
    this.pendingRev++
  }

  /** @param generation - openGeneration at launch; every await re-checks it and a stale pass
   *  drops all writes (resync superseded this open — its outcome belongs to a dead connection). */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    const controller = new AbortController()
    this.historyAbortController = controller
    try {
      let { result } = await this.history({ maxMessages: PAGE_MESSAGES }, controller.signal)
      if (generation !== this.openGeneration) return
      if (!result.ok) {
        this.openState = 'error'
        this.openError = result.error
        return
      }
      this.installWindow(
        result.value.events,
        result.value.hasMore,
        result.value.projections,
        result.value.omittedSpans,
      )
      // Gap detection: baseline past the window tail and liveBuffer did not cover it -> pull the tail page once more.
      const tailSeq = this.windowTailSeq()
      if (this.subscribedLastSeq !== null && tailSeq !== null && this.subscribedLastSeq > tailSeq) {
        result = (await this.history({ maxMessages: PAGE_MESSAGES }, controller.signal)).result
        if (generation !== this.openGeneration) return
        if (result.ok) {
          this.installWindow(
            result.value.events,
            result.value.hasMore,
            result.value.projections,
            result.value.omittedSpans,
          )
        }
      }
      this.openState = 'open'
      if (this.stageActive && this.running) this.beginLiveHistory()
    } catch (error) {
      if (generation !== this.openGeneration) return
      this.openState = 'error'
      const folded = transportError<never>(error)
      /* v8 ignore next -- the `? null` arm is unreachable: transportError always returns ok:false. */
      this.openError = folded.ok ? null : folded.error
    } finally {
      if (this.historyAbortController === controller) this.historyAbortController = null
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Install a fresh history window + stitch the liveBuffer (seq is the sole dedup key).
   *  This path is reserved for initial open and resync; gap repair uses the
   *  merge path below. Stitching MUST NOT route through acceptLiveEvent: openState is still 'loading' here
   *  (doOpen flips it after install), so recursing would push every buffered event straight
   *  back into liveBuffer where nothing ever drains it — a silent drop loop.
   *  A carried projections block seeds the value store (higher seq wins, so a stale
   *  baseline cannot overwrite a newer push frame); the window events themselves are
   *  never folded — the host is the only computation site. */
  private installWindow(
    entries: HistoryEntry[],
    hasMore: boolean,
    projections?: ProjectionsBaseline,
    omittedSpans?: readonly HistoryOmittedSpan[],
  ): void {
    this.events = entries.map(e => e.event)
    this.views = entries.map(e => e.view)
    this.omittedSpans = [...(omittedSpans ?? [])]
    this.baseSeq = logicalBaseSeq(this.events, this.omittedSpans) ?? 0
    this.hasMore = hasMore
    this.historyWindowMode = 'tail'
    const visible = this.events.findLast(hasConversationContent)
    if (visible !== undefined) this.markConversationContent(visible.seq)
    if (this.events.some(event => event.type === 'turn/start')) this.firstPromptPendingTurn = false
    for (const event of this.events) this.observeSubmissionEvent(event)
    this.conversation.replaceWindow(entries.map(conversationInput), hasMore)
    if (projections !== undefined) this.projections.seed(projections)
    const buffered = this.liveBuffer
    this.liveBuffer = []
    for (const item of buffered) this.appendLive(item.event, item.view)
    this.notifier.markDirty()
  }

  /** Seq-guarded append shared by stitching and the open-state live path. */
  private appendLive(event: SessionEvent, view?: ToolEventView): ConversationPublication {
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq <= tailSeq) return 'none' // replay overlap, drop
    this.events.push(event)
    this.views.push(view)
    if (hasConversationContent(event)) this.markConversationContent(event.seq)
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    const queueChanged = this.queueMirror.acceptDurable(event)
    this.observeSubmissionEvent(event)
    const publication = this.conversation.append({ event, view })
    return queueChanged ? 'immediate' : publication
  }

  /** Observe a durable user message carrying a browser submission identity. */
  private observeSubmissionEvent(event: SessionEvent): void {
    if (event.type !== 'user/message' || this.submissionSettlements.size === 0) return
    const source = event.data.source
    if (source.kind !== 'user' || !('rpcId' in source) || typeof source.rpcId !== 'string') return
    this.scheduleObservedRetirement(source.rpcId, imageRefsIn(event.data.content))
  }

  /** Observe queue occurrences that carry a browser submission identity. */
  private observeSubmissionQueue(items: readonly {
    readonly rpcId?: RpcId
    readonly message: { readonly content: unknown }
  }[]): void {
    if (this.submissionSettlements.size === 0) return
    for (const item of items) {
      if (item.rpcId !== undefined) this.scheduleObservedRetirement(item.rpcId, imageRefsIn(item.message.content))
    }
  }

  /** Latch an observed settlement and retire one frame later. */
  private scheduleObservedRetirement(requestId: RpcId, attachments: readonly ImageAttachmentRef[]): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    scheduleFrame(() => { this.finishSubmission(requestId, { reason: 'observed', attachments }) })
  }

  /** Retire one local echo immediately after a failed prompt or pre-admission abort. */
  private retireFailedSubmission(requestId: RpcId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    this.finishSubmission(requestId, { reason: 'failed' })
  }

  /** Single removal point for local submission echoes. */
  private finishSubmission(requestId: RpcId, retirement: PendingSubmissionRetirement): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined) return
    this.submissionSettlements.delete(requestId)
    this.pendingSubmissions = this.pendingSubmissions.filter(item => item.requestId !== requestId)
    this.notifier.markDirty()
    settlement.onRetire?.(retirement)
  }

  /** Land a live session/event (open/repair in flight -> buffer; overlapping seq -> drop;
   *  a seq gap -> buffer + tail-page repull instead of appending a hole (a gap is an
   *  expected reconnect-window artifact, repaired by refetch). The window stays one contiguous
   *  raw range, which lets Conversation Definitions correlate every recorded event between its
   *  ends and lets a compaction checkpoint resolve its cited summary event. */
  private acceptLiveEvent(event: SessionEvent, view?: ToolEventView): void {
    if (this.openState === 'loading' || this.stitching) {
      this.liveBuffer.push({ event, view })
      return
    }
    if (this.openState !== 'open') return // cold/error: no window upkeep (history fully backfills on open)
    const tailSeq = this.windowTailSeq()
    if (tailSeq !== null && event.seq > tailSeq + 1) {
      this.liveBuffer.push({ event, view })
      void this.repairGap()
      return
    }
    this.scheduleConversation(this.appendLive(event, view))
  }

  /** Route assembler cadence into the Session's existing microtask/RAF notifier. */
  private scheduleConversation(publication: ConversationPublication): void {
    if (publication === 'immediate') this.notifier.markDirty()
    else if (publication === 'animation-frame') this.notifier.markFrameDirtyThrottled()
  }

  /** Mark durable non-empty content and report its latest sequence to the list owner. */
  private markConversationContent(visibleContentSeq: number): void {
    this.conversationContentObserved = true
    if (this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    this.options.onEngaged?.(this, visibleContentSeq)
  }

  /** Start one cancellable background expansion for the staged live session. */
  private beginLiveHistory(): void {
    if (!this.stageActive || this.historyWindowMode === 'live' || this.historyWindowMode === 'expanding') return
    this.historyWindowMode = 'expanding'
    this.notifier.markDirty()
    const operation = this.enqueueHistoryOperation(signal => this.expandHistory(signal), true)
    this.historyExpansionPromise = operation
    void operation.catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.error('[web-runtime] live history expansion failed:', error)
      }
      if (this.stageActive && this.historyWindowMode === 'expanding') {
        this.historyWindowMode = 'tail'
        this.notifier.markDirty()
      }
    }).finally(() => {
      if (this.historyExpansionPromise === operation) this.historyExpansionPromise = null
    })
  }

  /**
   * Serialize history mutations so automatic pages, detail fills, and gap
   * repairs cannot install competing windows. Older pages are collected before
   * one publication, which keeps the reader's current DOM stable.
   */
  private enqueueHistoryOperation(
    operation: (signal: AbortSignal) => Promise<void>,
    olderBusy: boolean,
  ): Promise<void> {
    const previous = this.historyOperation
    const current = (async () => {
      if (previous !== null) await previous.catch(() => undefined)
      const controller = new AbortController()
      this.historyAbortController = controller
      if (olderBusy) {
        this.loadingOlder = true
        this.notifier.markDirty()
      }
      try {
        await operation(controller.signal)
      } finally {
        if (this.historyAbortController === controller) this.historyAbortController = null
        if (olderBusy) {
          this.loadingOlder = false
          this.notifier.markDirty()
        }
      }
    })()
    this.historyOperation = current
    return current.finally(() => {
      if (this.historyOperation === current) this.historyOperation = null
    })
  }

  /** Read one validated page without changing the installed window. */
  private async fetchHistoryPage(
    payload: { beforeSeq?: number; maxMessages?: number },
    signal: AbortSignal,
  ): Promise<HistoryPage | undefined> {
    const { result } = await this.history(payload, signal)
    if (!result.ok) return undefined
    return {
      entries: result.value.events,
      hasMore: result.value.hasMore,
      ...(result.value.projections === undefined ? {} : { projections: result.value.projections }),
      omittedSpans: [...(result.value.omittedSpans ?? [])],
    }
  }

  /** Apply one older page after asserting its logical tail touches the window. */
  private applyOlderPage(page: HistoryPage): boolean {
    if (page.entries.length === 0 && page.omittedSpans.length === 0) {
      this.hasMore = page.hasMore
      this.conversation.prepend([], this.hasMore)
      return true
    }
    const olderTail = logicalTailSeq(page.entries.map(entry => entry.event), page.omittedSpans)
    if (olderTail === null || olderTail + 1 !== this.baseSeq) {
      // Continuity assertion: on violation drop the page fail-soft rather than render an out-of-order stream.
      console.error(`[web-runtime] history page discontinuous: tail seq ${olderTail} vs baseSeq ${this.baseSeq}`)
      this.hasMore = false
      this.conversation.prepend([], false)
      return false
    }
    this.applyOlderPages([page], page.hasMore)
    return true
  }

  /** Merge a batch of contiguous older pages and publish one prepend. */
  private applyOlderPages(pages: readonly HistoryPage[], hasMore: boolean): void {
    const existing = new Set(this.events.map(event => event.seq))
    const fresh = pages.flatMap(page => page.entries)
      .filter(entry => !existing.has(entry.event.seq))
      .sort((left, right) => left.event.seq - right.event.seq)
    const freshSeqs = new Set(fresh.map(entry => entry.event.seq))
    this.events = [
      ...fresh.map(entry => entry.event),
      ...this.events.filter(event => !freshSeqs.has(event.seq)),
    ]
    this.views = [
      ...fresh.map(entry => entry.view),
      ...this.views,
    ]
    this.omittedSpans = [
      ...pages.flatMap(page => page.omittedSpans),
      ...this.omittedSpans,
    ]
    this.baseSeq = logicalBaseSeq(this.events, this.omittedSpans) ?? this.baseSeq
    this.dropCoveredSpans()
    this.hasMore = hasMore
    this.conversation.prepend(fresh.map(conversationInput), this.hasMore)
  }

  /**
   * Fill every older page for the active stage without blocking the model.
   * Partial progress is retained; an aborted or failed walk leaves the normal
   * manual paging entry available after the current turn.
   */
  private async expandHistory(signal: AbortSignal): Promise<void> {
    const generation = this.openGeneration
    if (!this.stageActive) return
    if (this.openState !== 'open') await this.open()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- leaveStage/resync may run while open() yields.
    if (!this.stageActive || generation !== this.openGeneration) return
    if (this.openState !== 'open') {
      this.historyWindowMode = 'tail'
      this.notifier.markDirty()
      return
    }
    if (!this.hasMore) {
      this.historyWindowMode = 'live'
      this.notifier.markDirty()
      return
    }

    const pages: HistoryPage[] = []
    let beforeSeq = this.baseSeq
    let hasMore: boolean = this.hasMore
    let previousOldest = Number.POSITIVE_INFINITY
    let complete = false
    let failure: unknown
    for (let guard = 0; guard < MAX_HISTORY_EXPANSION_PAGES; guard++) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stage and generation can change during the awaited page.
      if (!this.stageActive || generation !== this.openGeneration || signal.aborted) return
      let page: HistoryPage | undefined
      try {
        page = await this.fetchHistoryPage({ beforeSeq, maxMessages: PAGE_MESSAGES }, signal)
      } catch (error: unknown) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancellation can arrive while the carrier awaits.
        if (signal.aborted) throw error instanceof Error ? error : new Error(String(error))
        failure = error
        break
      }
      if (page === undefined) break
      hasMore = page.hasMore
      if (page.entries.length === 0 && page.omittedSpans.length === 0) {
        complete = !hasMore
        break
      }
      const pageTail = logicalTailSeq(page.entries.map(entry => entry.event), page.omittedSpans)
      const oldest = logicalBaseSeq(page.entries.map(entry => entry.event), page.omittedSpans)
      if (pageTail === null || oldest === null || pageTail + 1 !== beforeSeq
        || oldest >= beforeSeq || oldest >= previousOldest) {
        console.error(`[web-runtime] live history expansion stopped at seq ${String(oldest)}`)
        break
      }
      pages.push(page)
      if (!hasMore) {
        complete = true
        break
      }
      previousOldest = oldest
      beforeSeq = oldest
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    }

    // oxlint-disable-next-line typescript/no-unnecessary-condition -- leaveStage/resync may run during the final page merge.
    if (!this.stageActive || generation !== this.openGeneration || signal.aborted) return
    if (pages.length > 0) this.applyOlderPages(pages, hasMore)
    else if (!hasMore) {
      this.hasMore = false
      this.conversation.prepend([], false)
    }
    this.historyWindowMode = complete && !this.hasMore ? 'live' : 'tail'
    this.notifier.markDirty()
    if (failure !== undefined) {
      if (failure instanceof Error) throw failure
      const detail = typeof failure === 'string' ? failure : JSON.stringify(failure)
      throw new Error(detail)
    }
  }

  /**
   * Resync-lite: repull the tail page and merge it into the existing window.
   * A recovery read must never turn an active conversation into a bounded tail;
   * events arriving meanwhile stay in liveBuffer until the merge completes.
   */
  private async repairGap(): Promise<void> {
    /* v8 ignore next -- re-entry guard: acceptLiveEvent already detours to liveBuffer while stitching, so no second call reaches here. */
    if (this.stitching) return
    this.stitching = true
    const generation = this.openGeneration
    try {
      await this.enqueueHistoryOperation(async (signal) => {
        if (generation !== this.openGeneration || this.openState !== 'open') return
        const page = await this.fetchHistoryPage({ maxMessages: PAGE_MESSAGES }, signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the operation may be superseded while the page awaits.
        if (page === undefined || generation !== this.openGeneration || this.openState !== 'open') return
        const previousHasMore = this.hasMore
        this.mergeHistoryEntries(page.entries)
        this.omittedSpans = [...this.omittedSpans, ...page.omittedSpans]
        this.dropCoveredSpans()
        this.baseSeq = logicalBaseSeq(this.events, this.omittedSpans) ?? this.baseSeq
        // A tail probe can prove that an existing bounded window still has an
        // older prefix, but it cannot create one after the window was complete.
        this.hasMore = previousHasMore && page.hasMore
        if (page.projections !== undefined) this.projections.seed(page.projections)
        this.conversation.replaceWindow(
          this.events.map((event, index) => ({ event, view: this.views[index] })),
          this.hasMore,
        )
        const buffered = this.liveBuffer
        this.liveBuffer = []
        for (const item of buffered) this.appendLive(item.event, item.view)
        this.notifier.markDirty()
      }, false)
    } catch (error) {
      console.error('[web-runtime] gap repair failed:', error)
    } finally {
      this.stitching = false
    }
  }

  private windowTailSeq(): number | null {
    return logicalTailSeq(this.events, this.omittedSpans)
  }

  private buildSnapshot(): ConversationSnapshot {
    if (this.pendingCache === null || this.pendingCache.rev !== this.pendingRev) {
      this.pendingCache = { rev: this.pendingRev, value: [...this.pending.values()] }
    }
    const chat = (this.conversation.snapshot('chat') as ChatSnapshot | undefined) ?? EMPTY_CHAT_SNAPSHOT
    const legacy = chat.legacy
    return {
      sessionId: this.sessionId,
      views: this.conversation,
      chat,
      nodes: legacy.nodes,
      turnTimings: legacy.turnTimings,
      turnEnds: legacy.turnEnds,
      partial: legacy.partial,
      runningCalls: legacy.runningCalls,
      pending: this.pendingCache.value,
      pendingSubmissions: this.pendingSubmissions,
      queue: this.queueMirror.snapshot(),
      running: this.running,
      subagent: this.address === undefined
        ? null
        : { address: this.address, parentAvailable: this.parentAvailable },
      composerPhase: derivePhase(
        hasVisibleConversationContent(chat)
          || (!this.blankBit && !this.firstPromptPendingTurn)
          || this.running
          || this.pendingCache.value.length > 0,
        this.promptAttempted,
      ),
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      historyWindowMode: this.historyWindowMode,
      historyDetail: this.historyDetail,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
    }
  }

  /** Select ordinary or addressed history transport from the stored browser fact. */
  private history(
    payload: { beforeSeq?: number; maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<RpcResponse<{
    events: HistoryEntry[]
    hasMore: boolean
    projections?: ProjectionsBaseline
    omittedSpans?: readonly HistoryOmittedSpan[]
  }>> {
    const detail = this.historyDetail === 'conversation' ? 'conversation' as const : 'full' as const
    return this.address === undefined
      ? this.api.sessions.history({ sessionId: this.sessionId, ...payload, detail }, signal)
      : this.api.subagents.history({ ...this.address, ...payload, detail }, signal)
  }

  /**
   * Walk `detail: 'full'` pages from the tail until every omitted span in the
   * current window is present as an event. Existing seqs win on merge.
   */
  private async fillHistoryDetail(signal: AbortSignal): Promise<void> {
    if (this.openState !== 'open') return
    this.historyDetail = 'filling'
    this.notifier.markDirty()
    const generation = this.openGeneration
    const windowBase = this.baseSeq
    try {
      if (this.omittedSpans.length === 0) {
        if (generation === this.openGeneration) this.historyDetail = 'full'
        return
      }
      let beforeSeq: number | undefined
      let previousOldest = Number.POSITIVE_INFINITY
      for (let guard = 0; guard < MAX_HISTORY_EXPANSION_PAGES; guard++) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- later iterations follow an awaited history request.
        if (generation !== this.openGeneration || this.openState !== 'open') return
        if (this.omittedSpans.length === 0) break
        const { result } = await this.history({
          ...beforeSeq === undefined ? {} : { beforeSeq },
          maxMessages: PAGE_MESSAGES,
        }, signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- callbacks can replace the generation while history() yields.
        if (generation !== this.openGeneration || this.openState !== 'open') return
        if (!result.ok || result.value.events.length === 0) break
        const oldest = result.value.events.reduce(
          (min, entry) => Math.min(min, entry.event.seq),
          Number.POSITIVE_INFINITY,
        )
        this.mergeHistoryEntries(result.value.events)
        this.dropCoveredSpans()
        this.conversation.replaceWindow(
          this.events.map((event, index) => ({ event, view: this.views[index] })),
          this.hasMore,
        )
        this.notifier.markDirty()
        if (oldest <= windowBase || !result.value.hasMore || oldest >= previousOldest) break
        previousOldest = oldest
        beforeSeq = oldest
      }
      if (generation === this.openGeneration) {
        this.historyDetail = this.omittedSpans.length === 0 ? 'full' : 'conversation'
      }
    } catch (error) {
      // A transport/dependency failure must leave the retryable conversation
      // tier visible; retaining `filling` would make the control look busy
      // after the request has already settled.
      if (generation === this.openGeneration) {
        this.historyDetail = 'conversation'
      }
      throw error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Merge incoming rows by seq; already-loaded events keep their view. */
  private mergeHistoryEntries(incoming: readonly HistoryEntry[]): void {
    const bySeq = new Map<number, { event: SessionEvent; view: ToolEventView | undefined }>()
    for (const [index, event] of this.events.entries()) {
      bySeq.set(event.seq, { event, view: this.views[index] })
    }
    for (const entry of incoming) {
      if (bySeq.has(entry.event.seq)) continue
      bySeq.set(entry.event.seq, { event: entry.event, view: entry.view })
    }
    const sorted = [...bySeq.entries()].sort((left, right) => left[0] - right[0])
    this.events = sorted.map(([, row]) => row.event)
    this.views = sorted.map(([, row]) => row.view)
    this.baseSeq = logicalBaseSeq(this.events, this.omittedSpans) ?? this.baseSeq
  }

  /** Drop omitted spans whose seqs are now present as loaded events. */
  private dropCoveredSpans(): void {
    this.omittedSpans = this.omittedSpans.filter((span) => {
      // Count loaded rows inside the span instead of iterating the numeric
      // interval. A malformed or very old span can be millions of sequence
      // numbers wide while the actual window contains only a few rows.
      const expected = span.endSeq - span.startSeq + 1
      if (!Number.isSafeInteger(expected) || expected > this.events.length) return true
      let covered = 0
      for (const event of this.events) {
        if (event.seq >= span.startSeq && event.seq <= span.endSeq) covered++
      }
      return covered !== expected
    })
  }
}

/** Inclusive min seq over loaded events and omitted spans. */
function logicalBaseSeq(
  events: readonly SessionEvent[],
  spans: readonly HistoryOmittedSpan[],
): number | null {
  let base: number | null = events[0]?.seq ?? null
  for (const span of spans) {
    if (base === null || span.startSeq < base) base = span.startSeq
  }
  return base
}

/** Inclusive max seq over loaded events and omitted spans. */
function logicalTailSeq(
  events: readonly SessionEvent[],
  spans: readonly HistoryOmittedSpan[],
): number | null {
  let tail: number | null = events[events.length - 1]?.seq ?? null
  for (const span of spans) {
    if (tail === null || span.endSeq > tail) tail = span.endSeq
  }
  return tail
}

/** Convert one wire history row into the assembler's transport-neutral input. */
function conversationInput(entry: HistoryEntry): ConversationEventInput {
  return { event: entry.event, view: entry.view }
}

/** A generic command row alone remains control-plane content; every other visible Chat Node activates the conversation. */
function hasVisibleConversationContent(chat: ChatSnapshot): boolean {
  return chat.order.some(key => chat.nodes.get(key)?.kind !== 'command')
}

/** Read durable image references from a model content list without trusting wire data. */
function imageRefsIn(content: unknown): readonly ImageAttachmentRef[] {
  if (!Array.isArray(content)) return []
  const refs: ImageAttachmentRef[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { readonly type?: unknown; readonly attachment?: unknown }
    if (candidate.type !== 'image' || typeof candidate.attachment !== 'object' || candidate.attachment === null) continue
    refs.push(candidate.attachment as ImageAttachmentRef)
  }
  return refs
}

/** Run one callback on the next animation frame, or a macrotask in non-visual tests. */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fn() })
  else setTimeout(fn, 0)
}

/**
 * The composerPhase judgment — the single site that knows the predicate
 * (consumers switch on the result, never re-derive). A failed first prompt
 * stays engaging until an authoritative accepted-turn, running, or pending
 * signal arrives (retry semantics — see ComposerPhase).
 * @param hasContent - authoritative non-blank activity beyond a pending first
 *   prompt, visible non-command Chat content, a running turn, or a pending interaction.
 * @param promptAttempted - a prompt was initiated on this session object.
 * @returns the derived phase.
 */
function derivePhase(hasContent: boolean, promptAttempted: boolean): ComposerPhase {
  if (hasContent) return 'active'
  return promptAttempted ? 'engaging' : 'blank'
}
