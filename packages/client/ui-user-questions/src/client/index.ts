/**
 * Web question plugin, browser half: QuestionComposer registered as a
 * selector-routed entry of the conversation-declared composer chain, plus the
 * `question` dictionaries and the late-reply conversation node. The selector
 * narrows the owner's currency to the question carrier (matched prop), and the
 * whole behavior surface rides the carrier (domain encoding in contract/slots.ts
 * PendingQuestion); copy rides the standard locale seat. Export discipline:
 * packages/client/AGENTS.md.
 *
 * Cards outlive their wire wait: a timed ask_user_question returns `pending`
 * while its card stays answerable, published into the Session pending feed
 * (Session.publishInteraction) so the composer chain sees it beside the wire
 * PendingWait entries. A call-keyed card answers through
 * `remote.userQuestions.answer` once the projection calls the row continued.
 */
import { PendingWait } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientContext, SessionBinding, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-user-questions/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AskUserQuestionItem, PendingUserQuestion, UserQuestionProjectionView } from '@deepseek-ai/dsh-user-questions/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { UserQuestionPanels, UserQuestionRecord } from '@deepseek-ai/dsh-client-ui-tool/client'
// A transcript row hands its call id over as the plain string the wire carried.
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import {
  PendingQuestion, type QuestionRpcChannel, type QuestionWaterfallChannel,
} from './contract/slots.ts'
import { createQuestionDraftStore } from './draft-store.ts'
import { QuestionComposer } from './QuestionComposer.tsx'
import { questionReplyDefinition } from './question-reply.ts'
import { QuestionReplyView } from './QuestionReplyView.tsx'
import { en, zh, type QuestionKey } from './locales.ts'

export { PendingQuestion } from './contract/slots.ts'
export type {
  PlanReview, QuestionAnswer, QuestionComposerProps, QuestionWait,
} from './contract/slots.ts'
export type { QuestionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface SessionReferenceSourceMap {
    /** A session with an open question card: its pending feed, draft store, and Session object stay alive. */
    userQuestion: true
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The question composer's copy. */
    question: QuestionKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'question'

/** Required services: Session scopes, Remote answer/claim calls, node registry, slot registry, copy. */
export const inject = ['sessions', 'remote', 'remote.userQuestions', 'slots', 'locale', 'conversationEvents']

/** The wire-error codes a Client wait response carries, and the gateway-facing code each maps to. */
const REJECTION_WIRE: Record<'ASK_CANCELLED' | 'ASK_TIMED_OUT', 'cancelled' | 'timed-out'> = {
  ASK_CANCELLED: 'cancelled',
  ASK_TIMED_OUT: 'timed-out',
}
const REJECTION_MESSAGE: Record<'ASK_CANCELLED' | 'ASK_TIMED_OUT', string> = {
  ASK_CANCELLED: 'the user cancelled ask_user_question',
  ASK_TIMED_OUT: 'ask_user_question timed out before the user answered',
}

/** Rejection codes delivered back through a PendingWait response. */
type WireRejection = keyof typeof REJECTION_WIRE

/**
 * The question payload of one `question/requested` wire wait: the item list
 * plus the Host-named wait record (call identity and timed flag) when the
 * caller asked for a bounded foreground window.
 */
type QuestionWaitPayload = PendingWait<'question'>['payload'] & { wait?: { callId: ToolCallId; timed?: boolean } }

/** One card and the composer seat it moves in and out of. */
interface QuestionCard {
  readonly pending: PendingQuestion
  /**
   * User-level dismissal: a hidden card stays out of every pending feed until
   * its tool call row reveals it again.
   */
  hidden: boolean
  /** The Session object currently carrying the card's pending-feed entry. */
  publishedInto: SessionFace | undefined
  /** Withdraw the current pending-feed entry. */
  unpublish: (() => void) | undefined
  /** Release the scope retention keeping this card's Session alive. */
  releaseRetain: (() => void) | undefined
  /** Withdraw the panel from the composer seat; the request and its countdown stand. */
  readonly hide: () => void
  /** Publish the panel again, so it wins the seat against any other pending question. */
  readonly reveal: () => void
  /** Drop the card for good: the projection no longer lists its call. */
  readonly remove: () => void
}

/** A publish call's anchor: the Session object fed and the entry's withdrawal. */
interface CardPublication {
  readonly session: SessionFace
  readonly unpublish: () => void
}

/**
 * Cards published into the Session pending feed, keyed by `PendingQuestion.key`.
 * A tool-call-keyed card is shared by the wire wait and the Session projection.
 *
 * A card outlives its seat. Closing the panel only unpublishes it, which keeps
 * the request answerable from its tool call row, so this registry — not the
 * pending feed — decides when a request is over.
 */
class QuestionCards {
  readonly #cards = new Map<string, QuestionCard>()
  readonly #waits = new Map<string, QuestionCard>()

  constructor(
    private readonly bindingFor: (sessionId: SessionId) => SessionBinding | undefined,
    private readonly publish: (binding: SessionBinding, pending: PendingQuestion) => CardPublication,
    /** Retain the card's session scope until release; a live card must outlive deselection. */
    private readonly retain: (sessionId: SessionId) => () => void,
  ) {}

  byCallId(sessionId: SessionId, callId: string): QuestionCard | undefined {
    return this.#cards.get(PendingQuestion.keyOf(sessionId, callId))
  }

  /** The card a wire wait was adopted into, when one exists. */
  byWaitKey(waitKey: string): QuestionCard | undefined {
    return this.#waits.get(waitKey)
  }

  /**
   * Forget the wait→card link once the wait leaves the pending feed, so a
   * replayed or replacement wait adopts a fresh channel instead of inheriting
   * a released one.
   * @param waitKey - wire wait key leaving the feed.
   * @returns the card the wait was parked on, when one exists.
   */
  dropWait(waitKey: string): QuestionCard | undefined {
    const card = this.#waits.get(waitKey)
    this.#waits.delete(waitKey)
    return card
  }

  /** Observable state for one card while the registry owns it. */
  source(key: string): PendingQuestion | undefined {
    return this.#cards.get(key)?.pending
  }

  values(): readonly QuestionCard[] {
    return [...this.#cards.values()]
  }

  /** Keys of every card registered for one Session. */
  keysFor(sessionId: SessionId): readonly string[] {
    return this.values().filter(card => card.pending.sessionId === sessionId).map(card => card.pending.key)
  }

  /**
   * Return the card of a tool call, creating and publishing it when absent.
   * A request without a call id always gets a fresh card.
   */
  ensure(sessionId: SessionId, questions: readonly AskUserQuestionItem[], callId: ToolCallId | undefined): QuestionCard {
    if (callId !== undefined) {
      const existing = this.byCallId(sessionId, callId)
      if (existing !== undefined) return existing
    }
    return this.#create(new PendingQuestion(sessionId, questions, callId, () => this.keysFor(sessionId)))
  }

  /**
   * Return the card carrying one wire wait, adopting the wait's stable key so a
   * reconnect replay reuses the card instead of minting a twin.
   */
  ensureWait(sessionId: SessionId, wait: PendingWait<'question'>): QuestionCard {
    const callId = wait.payload.wait?.callId
    if (callId !== undefined) {
      const existing = this.byCallId(sessionId, callId)
      if (existing !== undefined) {
        this.#waits.set(wait.key, existing)
        return existing
      }
    } else {
      const existing = this.#waits.get(wait.key)
      if (existing !== undefined) return existing
    }
    const card = this.#create(new PendingQuestion(sessionId, wait.payload.questions, callId, () => this.keysFor(sessionId)))
    this.#waits.set(wait.key, card)
    return card
  }

  /** Publish one carrier into the Session pending feed and register the card that owns it. */
  #create(pending: PendingQuestion): QuestionCard {
    const card: QuestionCard = {
      pending,
      hidden: false,
      publishedInto: undefined,
      unpublish: undefined,
      releaseRetain: this.retain(pending.sessionId),
      hide: () => {
        card.hidden = true
        card.unpublish?.()
        card.unpublish = undefined
      },
      reveal: () => {
        card.hidden = false
        this.publishCard(card)
      },
      remove: () => {
        /* v8 ignore next -- a card leaves the registry once; no caller holds a card the registry already replaced. */
        if (this.#cards.get(pending.key) !== card) return
        this.#cards.delete(pending.key)
        for (const [waitKey, holder] of this.#waits) {
          if (holder === card) this.#waits.delete(waitKey)
        }
        pending.close()
        card.unpublish?.()
        card.unpublish = undefined
        card.releaseRetain?.()
        card.releaseRetain = undefined
      },
    }
    this.publishCard(card)
    // A review card has no request left to park: closing it drops the card, and
    // the tool call row builds another one from the same transcript record.
    pending.attachSeat({ hide: pending.review === undefined ? card.hide : card.remove })
    this.#cards.set(pending.key, card)
    return card
  }

  /**
   * Publish a card into its session's current pending feed, re-anchoring when
   * the Session object changed. A session leave releases the scope and its
   * pending feed wholesale; the card itself is still answerable, so its next
   * binding must carry a fresh entry.
   */
  publishCard(card: QuestionCard): void {
    const binding = this.bindingFor(card.pending.sessionId)
    if (binding === undefined) return
    if (binding.session === card.publishedInto && card.unpublish !== undefined) return
    card.unpublish?.()
    card.publishedInto = binding.session
    card.unpublish = this.publish(binding, card.pending).unpublish
  }

  /**
   * Re-anchor every live card onto its session's current binding. A re-bound
   * Session starts with an empty published feed; cards that outlived the
   * release re-enter it here.
   */
  reanchor(bound: ReadonlyMap<SessionId, SessionBinding>): void {
    for (const card of this.#cards.values()) {
      if (card.hidden || !bound.has(card.pending.sessionId)) continue
      this.publishCard(card)
    }
  }

  /**
   * Show the panel of one answerable tool call.
   * @param sessionId - Session the tool call belongs to.
   * @param callId - `ask_user_question` call whose panel to show, as its
   * transcript row spells it.
   * @returns whether a card for that call is still answerable.
   */
  reveal(sessionId: SessionId, callId: string): boolean {
    const card = this.byCallId(sessionId, callId)
    if (card === undefined) return false
    card.reveal()
    return true
  }

  /**
   * Show one settled tool call's recorded answers as a read-only card. A call
   * that somehow still holds a card is shown as it stands, so a live request is
   * never replaced by a stale copy of itself.
   * @param sessionId - Session the tool call belongs to.
   * @param callId - `ask_user_question` call whose record to show, as its
   * transcript row spells it.
   * @param record - the call's questions and recorded answers.
   * @returns true; a record always produces a card.
   */
  review(sessionId: SessionId, callId: string, record: UserQuestionRecord): boolean {
    const card = this.byCallId(sessionId, callId) ?? this.#create(new PendingQuestion(
      sessionId,
      record.questions,
      ToolCallId(callId),
      () => this.keysFor(sessionId),
      record.answers,
    ))
    card.reveal()
    return true
  }

  /**
   * Settle every live wait at plugin teardown. The Session pending feed only
   * holds what is currently published, and a hidden card is not in it, so its
   * Host request would wait for its own abort instead.
   */
  dispose(): void {
    for (const card of this.values()) {
      card.pending.delegate()
      card.remove()
    }
  }
}

/** Per-card live wait attachment: the wire wait, its settlement channel, and the open claim stream. */
interface WaitBinding {
  readonly wait: PendingWait<'question'>
  readonly card: QuestionCard
  readonly channel: QuestionWaterfallChannel
  readonly claimDispose: (() => void) | undefined
  readonly claimLifetime: AbortController
  /**
   * The Session object whose pending feed carried this wait. Only that object
   * may vouch for the wait's departure: a re-bound session replays nothing.
   */
  readonly sessionId: SessionId
  readonly session: SessionFace
}

/**
 * Answer a settled wire rejection on behalf of a card whose waterfall went
 * away: `delegate` hands the Host request a cancellation so a disposed
 * presentation releases the tool call instead of parking it forever.
 */
function respondRejection(wait: PendingWait<'question'>, code: WireRejection): void {
  try {
    void wait.respond({
      ok: false,
      error: { code: REJECTION_WIRE[code], message: REJECTION_MESSAGE[code], details: {} },
    })
  } catch {
    // A wait already settled by its resolved frame rejects nothing twice.
  }
}

/**
 * Bridge one wire wait onto a card's waterfall face: respond() backfills the
 * requested frame's rpcId, and a timed wait opens the Remote claim stream that
 * reports the Host-computed remaining duration once, then holds the claim.
 * @returns the attachment to detach when the wait leaves the pending feed.
 */
function adoptWait(
  ctx: ClientContext,
  sessionId: SessionId,
  session: SessionFace,
  wait: PendingWait<'question'>,
  card: QuestionCard,
  bindings: Map<string, WaitBinding>,
): void {
  if (bindings.has(wait.key)) return
  const waitInfo = (wait.payload as QuestionWaitPayload).wait
  const callId = waitInfo?.callId
  const claimLifetime = new AbortController()
  let deadline: number | undefined
  const channel: QuestionWaterfallChannel = {
    get deadline() { return deadline },
    resolve: (answer) => {
      void wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer } })
    },
    reject: (code) => { respondRejection(wait, code) },
    delegate: () => { respondRejection(wait, 'ASK_CANCELLED') },
  }
  const claim = waitInfo?.timed === true && callId !== undefined
    ? ctx.remote.userQuestions.attachWait(sessionId, callId, claimLifetime.signal)
    : undefined
  const binding: WaitBinding = {
    wait, card, channel, claimLifetime, sessionId, session,
    // The claim stream's lifetime is the AbortSignal; aborting ends it.
    claimDispose: claim === undefined ? undefined : () => { claimLifetime.abort() },
  }
  bindings.set(wait.key, binding)
  if (claim !== undefined) {
    void (async () => {
      try {
        const opening = await claim[Symbol.asyncIterator]().next()
        if (opening.done !== true && !claimLifetime.signal.aborted) {
          deadline = Date.now() + opening.value.remainingMs
        }
      } catch {
        // A dropped claim stream leaves the card answerable without a countdown.
      } finally {
        card.pending.attachWaterfall(channel)
      }
    })()
  } else {
    card.pending.attachWaterfall(channel)
  }
}

/** Release one wait attachment: close the claim stream and detach the channel from the card. */
function releaseWait(card: QuestionCard, binding: WaitBinding): void {
  binding.claimLifetime.abort()
  binding.claimDispose?.()
  card.pending.detachWaterfall(binding.channel)
}

/**
 * Mirror the wire waits and the `userQuestions` projection of every bound
 * Session onto the cards: open requests adopt their PendingWait, continued rows
 * get the Remote answer path, and a tool-call-keyed card whose call the
 * projection no longer lists is removed once its waterfall is gone.
 */
function reconcileQuestions(ctx: ClientContext, cards: QuestionCards): () => void {
  const sessions = ctx.sessions
  const stopProjections = new Map<SessionId, () => void>()
  const bindings = new Map<string, WaitBinding>()

  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const rpcFor = (sessionId: SessionId, callId: ToolCallId): QuestionRpcChannel => ({
    answer: async answer => unwrap(await ctx.remote.userQuestions.answer(sessionId, callId, answer)),
  })

  let reconciling = false
  let reconcileAgain = false
  const reconcile = (): void => {
    // Retaining a card's scope inside this pass re-enters through the list
    // subscription; schedule a second pass instead of mutating mid-iteration.
    if (reconciling) { reconcileAgain = true; return }
    reconciling = true
    try {
      do {
        reconcileAgain = false
        reconcilePass()
      } while (reconcileAgain)
    } finally {
      reconciling = false
    }
  }
  const reconcilePass = (): void => {
    const snapshot = sessions.list.getSnapshot()
    const bound = new Map(Object.values(snapshot.byId).flatMap((summary) => {
      const binding = sessions.binding(summary.id)
      return binding === undefined ? [] : [[summary.id, binding] as const]
    }))
    for (const [sessionId, stop] of stopProjections) {
      if (bound.has(sessionId)) continue
      stop()
      stopProjections.delete(sessionId)
    }
    for (const [sessionId, binding] of bound) {
      if (stopProjections.has(sessionId)) continue
      const stopSession = binding.session.subscribe(reconcile)
      const stopProjection = binding.session.projections.faceOf('userQuestions').subscribe(reconcile)
      stopProjections.set(sessionId, () => { stopSession(); stopProjection() })
    }

    // Re-anchor live cards whose session left and re-bound since last pass.
    cards.reanchor(bound)

    // Collect the live wire waits and the projected rows in one pass.
    const rows = new Map<string, { sessionId: SessionId; row: PendingUserQuestion }>()
    const liveWaitKeys = new Set<string>()
    for (const [sessionId, binding] of bound) {
      for (const entry of binding.session.getSnapshot().pending) {
        if (!(entry instanceof PendingWait) || entry.kind !== 'question') continue
        liveWaitKeys.add(entry.key)
        const card = cards.ensureWait(sessionId, entry)
        if (!card.pending.hasWaterfall()) {
          adoptWait(ctx, sessionId, binding.session, entry, card, bindings)
        }
      }
      const projected = binding.session.projections.faceOf('userQuestions').getSnapshot() as
        UserQuestionProjectionView | undefined
      for (const row of projected?.active ?? []) {
        rows.set(PendingQuestion.keyOf(sessionId, row.callId), { sessionId, row })
      }
    }
    for (const { sessionId, row } of rows.values()) {
      if (row.state === 'continued') {
        const card = cards.ensure(sessionId, row.questions, row.callId)
        card.pending.attachRpc(rpcFor(sessionId, row.callId))
        card.pending.setState('continued')
        continue
      }
      cards.byCallId(sessionId, row.callId)?.pending.setState('open')
    }

    // Detach waits that left the feed; a call-less card ends with its wait.
    // Only the Session object that carried the wait vouches for its
    // departure: a released scope replays no pending waits, so absence after a
    // re-bind is not a settlement.
    for (const [waitKey, binding] of bindings) {
      if (liveWaitKeys.has(waitKey)) continue
      if (bound.get(binding.sessionId)?.session !== binding.session) continue
      bindings.delete(waitKey)
      const card = cards.dropWait(waitKey)
      if (card === undefined) continue
      releaseWait(card, binding)
      if (card.pending.callId === undefined) card.remove()
    }
    const boundWaits = new Set([...bindings.values()].map(binding => binding.card))
    for (const card of cards.values()) {
      // A review card's call already settled, so the projection no longer lists it as answerable.
      if (card.pending.callId === undefined
        || card.pending.review !== undefined
        || rows.has(card.pending.key)
        || card.pending.hasWaterfall()
        || boundWaits.has(card)) continue
      card.remove()
    }
  }

  reconcile()
  const stopList = sessions.list.subscribe(reconcile)
  return () => {
    stopList()
    for (const stop of stopProjections.values()) stop()
    stopProjections.clear()
    for (const binding of bindings.values()) binding.claimLifetime.abort()
    bindings.clear()
  }
}

/**
 * Client plugin body: register the `question` dictionaries, the question
 * composer into the composer chain, and the late-reply conversation node.
 * Zero business face — data and verbs live on the matched carrier; t rides
 * the standard locale seat.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-user-questions: dictionaries')

  const questionDraftStore = createQuestionDraftStore()
  const publish = (binding: SessionBinding, pending: PendingQuestion): CardPublication =>
    ({ session: binding.session, unpublish: binding.session.publishInteraction(pending) })
  const cards = new QuestionCards(
    id => ctx.sessions.binding(id),
    publish,
    (sessionId) => {
      const reference = ctx.sessions.retain(sessionId, { source: 'userQuestion' })
      return () => { reference.release() }
    },
  )
  ctx.effect(() => () => { cards.dispose() }, 'ui-user-questions: cards')
  const disposePanels = ctx.reflect.provide('userQuestionPanels', {
    reveal: (sessionId, callId) => cards.reveal(sessionId, callId),
    review: (sessionId, callId, record) => cards.review(sessionId, callId, record),
  } satisfies UserQuestionPanels)
  ctx.effect(() => disposePanels, 'ui-user-questions: answer panels')
  ctx.effect(() => reconcileQuestions(ctx, cards), 'ui-user-questions: question cards')
  ctx.slots.inject('conversation.composer', () => ctx.slots.register(
    {
      name: 'conversation.composer',
      select: ({ interactions }: ComposerChainProps): PendingQuestion | null =>
        interactions.find((entry): entry is PendingQuestion => entry instanceof PendingQuestion) ?? null,
      locale: NS,
      store: questionDraftStore,
      inject: () => ({ keyedHooks: { questionCard: (key: string) => cards.source(key) } }),
      children: { 'conversation.plan-review.actions': { kind: 'list', scope: 'session' } },
    },
    QuestionComposer,
  ))
  ctx.conversationEvents.register(questionReplyDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'question-reply',
    locale: NS,
  }, QuestionReplyView))
}
