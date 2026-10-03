/**
 * Service Definition for the authorization capability seam (`ctx.authorization`):
 * obtaining a credential nobody can supply from configuration alone, because
 * getting it requires a conversation with the human — open this page, paste
 * that code, pick an account.
 *
 * The seam owns the conversation and the lifecycle; it never owns the protocol.
 * A plugin that knows how to obtain its own credential registers a flow keyed
 * by the `CredentialKey` that flow writes, and the flow talks to whatever
 * surface started it through one neutral vocabulary of notices and prompts. So
 * a second authorization protocol arrives as another flow rather than as
 * another seam, and a surface that renders one flow renders all of them.
 *
 * ```ts
 * const dispose = ctx.authorization.registerFlow({
 *   key: credentialKey('llm-pi-ai', 'openai-codex'),
 *   label: 'ChatGPT (Codex)',
 *   methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
 *   async run(session) {
 *     session.notify({ message: 'Continue in your browser', url })
 *     const credential = await exchange(session.signal)
 *     await session.commit(async () => credential)
 *   },
 * })
 * ```
 *
 * @module @deepseek-ai/dsh-authorization
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'

import type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationSettlement,
} from './types.ts'

export type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
  AuthorizationPromptOption, AuthorizationSettlement, AuthorizationStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authorization: AuthorizationService
  }

  interface Events {
    /**
     * One authorization attempt has finished and released its key. Fires for
     * every terminal outcome, failures included, so a surface watching a key it
     * did not start (a second browser tab) learns the attempt is over.
     * @mode emit
     * @param key - the credential record the finished attempt was authorizing.
     * @param settlement - how it ended, including the `failed` case its caller sees as a thrown error.
     */
    'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
  }
}

/** Stable error taxonomy for authorization failures. */
export class AuthorizationError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'AuthorizationError'
  }
}

/**
 * The rejection an {@link AuthorizationInteraction.prompt} uses to say the
 * human declined — dismissed the question, chose not to answer — rather than
 * that the surface broke. An attempt whose flow fails after a prompt was
 * declined settles as `cancelled`, the same outcome as a withdrawn signal,
 * because the human saying no is a refusal, not a breakage. Only a human's
 * "no" may reject with this class: a prompt withdrawn by its own `signal` (a
 * flow retiring the losing question of a race) must reject with something
 * else, or a later genuine failure would be misread as a decline.
 */
export class AuthorizationDeclinedError extends AuthorizationError {
  constructor(message = 'the authorization prompt was declined') {
    super(message, 'DECLINED')
    this.name = 'AuthorizationDeclinedError'
  }
}

/**
 * What a running flow is given to talk to the human. Every member is scoped to
 * one attempt: the flow neither knows nor chooses which surface is listening.
 */
export interface AuthorizationSession {
  /** The method id the caller picked, always one this flow declared. */
  readonly method: string
  /** Aborted when the caller withdraws or `cancel()` is called for this key. */
  readonly signal: AbortSignal
  /**
   * Report progress, or tell the human what to do next. Fire-and-forget: a
   * surface that cannot render a notice must not stall the flow.
   * @param notice - the message, and any page or code it refers to.
   */
  notify(notice: AuthorizationNotice): void
  /**
   * Ask the human a question the flow cannot answer for itself.
   * @param prompt - what to ask, and how it should be presented.
   * @returns what the human typed, or the chosen option's id.
   * @throws when the human declines, or the prompt's own signal withdraws it.
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
  /**
   * Replace this attempt's credential record through the provider's
   * serialized read-modify-write — the only write the seam counts as the
   * flow's commit. The record is fixed to the flow's `key`: the callback
   * carries no address because the session already belongs to one.
   * Cancellation is observed at admission, again inside the exclusive
   * mutation, and once more before the replacement reaches storage; a write
   * admitted before a withdrawal lands anyway, so a record the human did
   * authorize is never revoked by a late cancel.
   * @param mutate - receives the current record and returns its replacement,
   *   or `undefined` to leave the record as it stands.
   * @returns the record after the write, or the current one when `mutate`
   *   declined.
   * @throws {AuthorizationError} code `WITHDRAWN` when the attempt was
   *   withdrawn, replaced, or released before the write could be admitted.
   */
  commit(
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
}

/**
 * A plugin's knowledge of how to obtain one credential. The flow owns the
 * write: `run()` resolving means the record for `key` is committed through
 * {@link AuthorizationSession.commit} during that run — the session's commit
 * is the only write the seam accepts as this attempt's, so an unrelated
 * same-key write cannot stand in for it. Committing inside the flow is what
 * lets a library that persists through its own store adapter (pi-ai's
 * `Models.login()`) stay the single writer instead of being copied back out
 * and written twice.
 */
export interface AuthorizationFlow {
  /** The credential record this flow writes. Its scope names the owning plugin. */
  readonly key: CredentialKey
  /** User-facing name of what is being authorized. */
  readonly label: string
  /**
   * The methods offered, most preferred first; a caller naming none gets the
   * first. Typed non-empty because a flow with nothing to run is a flow that
   * cannot be begun, and the type says so at the one place flows are written.
   */
  readonly methods: readonly [AuthorizationMethod, ...AuthorizationMethod[]]
  /**
   * Run one attempt to obtain and commit the credential.
   * @param session - the chosen method, the cancellation signal, and the interaction callbacks.
   * @returns once the record is committed.
   * @throws when the attempt fails or the human declines.
   */
  run(session: AuthorizationSession): Promise<void>
}

/**
 * The surface half of one attempt. Supplied with the request rather than
 * registered, because the caller that starts an authorization is the one that
 * can talk to the human about it: prompts reach exactly the page that asked,
 * and a headless caller supplies an interaction that declines.
 */
export interface AuthorizationInteraction {
  /**
   * Render a notice from the running flow.
   * @param notice - the message, and any page or code it refers to.
   */
  notify(notice: AuthorizationNotice): void
  /**
   * Put a question to the human and wait.
   * @param prompt - what to ask, and how it should be presented.
   * @returns the typed text, or the chosen option's id.
   * @throws {AuthorizationDeclinedError} when the human declines; any other
   *   rejection reads as the surface failing, not as an answer.
   */
  prompt(prompt: AuthorizationPrompt): Promise<string>
}

/** One request to authorize a key. */
export interface AuthorizationRequest {
  /** The credential record to authorize; a flow must be registered for it. */
  key: CredentialKey
  /** Which of the flow's methods to run. Defaults to the flow's first. */
  method?: string
  /** The surface that will render this attempt's notices and prompts. */
  interaction: AuthorizationInteraction
  /** Withdraws the whole attempt. */
  signal?: AbortSignal
}

/** One attempt in flight: its withdrawal handle and the state a commit guards. */
interface InFlight {
  readonly controller: AbortController
  /** The flow's own promise, kept so release can outlast the caller's answer. */
  flow?: Promise<void>
  /** Tail of every commit queued through this attempt, failures included. */
  queue: Promise<unknown>
  /**
   * `active`: withdrawal may still abort the attempt and retire its commits.
   * `committing`: a replacement passed the last checkpoint and is inside the
   * provider's storage operation — withdrawal is ignored from here on.
   * `committed`: an admitted write completed successfully through storage.
   * `failed`: an admitted write's storage operation rejected — the error is
   * retained so it reaches the caller once the owned tail drains.
   */
  phase: { status: 'active' | 'committing' | 'committed' } | { status: 'failed'; error: unknown }
  /** The flow promise settled; a later commit on this session must refuse. */
  flowSettled: boolean
  /** The reservation is released: a captured session's commit must refuse. */
  released: boolean
}

/**
 * `ctx.authorization`: a registry of credential-obtaining flows, one attempt at
 * a time per key.
 */
export class AuthorizationService extends Service {
  /** The commit this seam confirms is a credential-record write, so the store is required, not optional. */
  static inject = ['credentials']

  private readonly flows = new Map<CredentialKey, AuthorizationFlow>()
  private readonly running = new Map<CredentialKey, InFlight>()

  constructor(ctx: Context) {
    super(ctx, 'authorization')
  }

  /**
   * Offer a way to obtain one credential. One flow per key: two plugins
   * claiming the same key would each write a record in their own format, and
   * whichever ran last would leave the other reading a payload it cannot parse.
   *
   * @param flow - the key it writes, its label, its methods, and its runner.
   * @returns Disposer that withdraws this flow.
   * @throws {AuthorizationError} code `DUPLICATE_FLOW` when the key is already claimed.
   */
  registerFlow(flow: AuthorizationFlow): () => void {
    const dispose = this.ctx.effect(function* (this: AuthorizationService) {
      if (this.flows.has(flow.key)) {
        throw new AuthorizationError(
          `an authorization flow for "${flow.key}" is already registered`, 'DUPLICATE_FLOW')
      }
      this.flows.set(flow.key, flow)
      yield () => {
        this.flows.delete(flow.key)
        // A flow leaving mid-attempt takes its attempt with it: the runner
        // belongs to a plugin that is going away, so letting it keep prompting
        // would outlive the fiber that can answer for it. An attempt already
        // committing a write is past withdrawal — its storage operation
        // finishes on its own terms.
        const owner = this.running.get(flow.key)
        if (owner?.phase.status === 'active') owner.controller.abort()
      }
    }.bind(this), 'authorization.registerFlow()')
    return () => void dispose()
  }

  /**
   * Every registered flow, for a surface listing what can be authorized.
   * @returns one entry per flow, in registration order.
   */
  list(): readonly AuthorizationEntry[] {
    return [...this.flows.values()].map(flow => this.entry(flow))
  }

  /**
   * One registered flow.
   * @param key - the credential record to ask about.
   * @returns the entry, or undefined when no flow claims that key.
   */
  describe(key: CredentialKey): AuthorizationEntry | undefined {
    const flow = this.flows.get(key)
    return flow === undefined ? undefined : this.entry(flow)
  }

  /** The public view of one registered flow. */
  private entry(flow: AuthorizationFlow): AuthorizationEntry {
    return {
      key: flow.key,
      label: flow.label,
      methods: flow.methods,
      inFlight: this.running.has(flow.key),
    }
  }

  /**
   * Withdraw the attempt running for a key, if any. Separate from the
   * request's own signal because a request/response transport answers a Cancel
   * button on a second call, with no handle on the first one's signal.
   * Cancellation has no effect once a commit's write was admitted to storage:
   * the granted credential is allowed to land and the caller hears the write's
   * own outcome rather than a revoked grant.
   * @param key - the credential record whose attempt should stop.
   */
  cancel(key: CredentialKey): void {
    const owner = this.running.get(key)
    if (owner?.phase.status === 'active') owner.controller.abort()
  }

  /**
   * Run one attempt to authorize a key, and report how it ended.
   *
   * One attempt per key at a time. A second caller is refused rather than
   * joined: the two would be prompting different humans through the same flow,
   * and the second would answer questions the first was asked.
   *
   * @param request - the key, the method, the surface, and the cancel signal.
   * @returns `authorized` once the flow's record is committed during this
   *   attempt and observed, or `cancelled` when the human declined or the
   *   caller withdrew.
   * @throws {AuthorizationError} code `NO_FLOW` when nothing claims the key,
   *   `UNKNOWN_METHOD` when the named method is not one the flow offers,
   *   `ALREADY_IN_FLIGHT` when an attempt is already running for the key, or
   *   `NOT_COMMITTED` when the flow resolved without committing a record
   *   during the attempt.
   */
  async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
    const { key } = request
    const flow = this.flows.get(key)
    if (flow === undefined) {
      throw new AuthorizationError(`no authorization flow is registered for "${key}"`, 'NO_FLOW')
    }
    const method = request.method ?? flow.methods[0].id
    if (!flow.methods.some(candidate => candidate.id === method)) {
      throw new AuthorizationError(
        `authorization flow for "${key}" offers no method "${method}"`, 'UNKNOWN_METHOD')
    }
    if (this.running.has(key)) {
      throw new AuthorizationError(
        `an authorization attempt for "${key}" is already running`, 'ALREADY_IN_FLIGHT')
    }
    // Withdrawn before it began: never claim the slot and never run the flow.
    // Handing an aborted signal to `run()` would rely on every flow checking it
    // before its first await, and one that does not would hang holding the key.
    // Validation still runs first, so a caller naming a key or method that does
    // not exist hears about it whether or not it also gave up.
    if (request.signal?.aborted === true) return { status: 'cancelled' }
    const controller = new AbortController()
    const owner: InFlight = {
      controller, queue: Promise.resolve(), phase: { status: 'active' }, flowSettled: false, released: false,
    }
    // Withdrawal applies only while the attempt can still be withdrawn; a
    // commit already past its last checkpoint ignores it.
    const withdraw = (): void => { if (owner.phase.status === 'active') controller.abort(request.signal?.reason) }
    request.signal?.addEventListener('abort', withdraw, { once: true })
    this.running.set(key, owner)
    let settlement: AuthorizationSettlement = 'failed'
    try {
      const outcome = await this.attempt(flow, method, owner, request.interaction)
      settlement = outcome.status
      return outcome
    } finally {
      request.signal?.removeEventListener('abort', withdraw)
      if (controller.signal.aborted) {
        // The caller already heard cancelled; the reservation ends only once
        // the orphaned flow and its queued commit work quiesce, and the
        // settled event still fires after that release. A withdrawn session
        // cannot enqueue new commits, so this tail is the whole owned work.
        void Promise.allSettled([owner.flow ?? Promise.resolve(), owner.queue]).then(() => {
          try {
            this.finishRelease(key, owner, settlement)
          } catch (error) {
            this.warnSettledListenerFailure(key, error)
          }
        })
      } else {
        this.finishRelease(key, owner, settlement)
      }
    }
  }

  /**
   * End one attempt's reservation and fan out its settlement. The event fires
   * only here, and only after the key is released, so a listener that reacts
   * by starting the next attempt is never refused by the one that finished.
   * @param key - the credential record the finished attempt was authorizing.
   * @param owner - the attempt's owner record.
   * @param settlement - how the attempt ended.
   */
  private finishRelease(key: CredentialKey, owner: InFlight, settlement: AuthorizationSettlement): void {
    owner.released = true
    if (this.running.get(key) === owner) this.running.delete(key)
    this.settle(key, settlement)
  }

  /**
   * The session's serialized write to the attempt's own record.
   *
   * Admission refuses outright once the attempt is withdrawn, its flow has
   * settled, or this owner lost the key; inside the credential provider's
   * exclusive mutation the same checks run again (the write may have queued
   * behind another operation), then the mutation runs, then the checks run a
   * third time before the replacement is returned to storage — the committed
   * mark is set synchronously at that point, so a write already admitted
   * completes even if the attempt is withdrawn while storage is working.
   * @param key - the flow's credential record.
   * @param owner - the attempt this session belongs to.
   * @param mutate - receives the current record and returns its replacement, or `undefined` to retain it.
   * @returns the record after the write, or the current one when the mutation declined.
   */
  private commitRecord(
    key: CredentialKey,
    owner: InFlight,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const withdrawn = (when: string): AuthorizationError => new AuthorizationError(
      `authorization for "${key}" ${when}`, 'WITHDRAWN',
      owner.controller.signal.aborted ? { cause: owner.controller.signal.reason } : undefined)
    // Owner flags can flip while a commit is queued or mid-mutation; a named
    // closure keeps the checks beyond the compiler's across-await narrowing.
    const isRetired = (): boolean => owner.released || owner.controller.signal.aborted
      || owner.flowSettled || this.running.get(key) !== owner
    if (isRetired()) {
      return Promise.reject(withdrawn('no longer holds the record it is committing'))
    }
    // True only once this commit's replacement was handed to storage: a
    // no-op mutation admits nothing, so it can never reach `committed`.
    let admitted = false
    const work = owner.queue
      .then(() => this.ctx.credentials.modifyRecord(key, async (current) => {
        // The write may have queued behind unrelated work; admission may have
        // been withdrawn in the meantime.
        if (isRetired()) {
          throw withdrawn('was withdrawn before its credential write was admitted')
        }
        const next = await mutate(current)
        // A declined mutation is handed back undefined: the provider returns
        // the current record without writing or notifying.
        if (next === undefined) return undefined
        if (isRetired()) {
          throw withdrawn('was withdrawn while its credential write was in flight')
        }
        // Synchronous, ahead of the storage write: a committing attempt is
        // beyond recall — a withdrawal landing now cannot un-admit the write.
        owner.phase = { status: 'committing' }
        admitted = true
        return next
      }))
      // `committed` belongs to a fulfilled write, not to admission; an
      // admitted write's rejection is retained verbatim on the phase so the
      // unawaited tail cannot lose it, and passes through unchanged.
      .then((record) => {
        if (admitted) owner.phase = { status: 'committed' }
        return record
      }, (error: unknown) => {
        if (admitted) owner.phase = { status: 'failed', error }
        throw error
      })
    owner.queue = work.catch(() => {})
    return work
  }

  /* jscpd:ignore-start -- deliberate symmetry with the credentials seam's
     commit fan-out (`CredentialProvider`): the contained-dispatch shape is the
     reviewed listener-lifecycle contract, and extracting it would couple the
     two seams' event semantics. */
  /**
   * Fan `authorization/settled` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the finished attempt's own outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran. The attempt is already
   * over and its key released when this fires, so a broken watcher (that
   * second browser tab) can never turn the caller's settled result into a
   * failure of its own.
   */
  private settle(key: CredentialKey, settlement: AuthorizationSettlement): void {
    let invariantFailure: unknown
    const args = ['authorization/settled', key, settlement]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(key, settlement)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnSettledListenerFailure(key, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnSettledListenerFailure(key, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnSettledListenerFailure(key: CredentialKey, error: unknown): void {
    this.ctx.logger.warn('authorization: an authorization/settled listener for "%s" failed', key)
    this.ctx.logger.warn(error)
  }

  /** Run the flow, then hold it to its half of the commit contract. */
  private async attempt(
    flow: AuthorizationFlow,
    method: string,
    owner: InFlight,
    interaction: AuthorizationInteraction,
  ): Promise<AuthorizationOutcome> {
    const { signal } = owner.controller
    // Withdrawal settles the caller-visible outcome whether or not the flow
    // reacts to it. The orphaned run is left to finish on its own — the
    // reservation outlives this method, so nothing the flow still does is
    // read as another attempt's — but nothing awaits it here.
    const withdrawn = new Promise<'withdrawn'>((resolve) => {
      // `begin()` returns before claiming the key when its caller has already
      // withdrawn, so this signal cannot already be aborted here.
      signal.addEventListener('abort', () => { resolve('withdrawn') }, { once: true })
    })
    // A decline witnessed at the seam: a flow that rewraps the rejection on
    // its way out cannot hide it.
    const observed = { declined: false }
    const running = flow.run({
      method,
      signal,
      notify: (notice) => {
        try {
          interaction.notify(notice)
        } catch (error) {
          // Fire-and-forget is held at the seam: a surface that cannot
          // render a notice (a page whose connection just closed) loses the
          // notice, never the attempt.
          this.ctx.logger.warn('authorization: the interaction surface failed to render a notice')
          this.ctx.logger.warn(error)
        }
      },
      prompt: prompt => interaction.prompt(prompt).catch((error: unknown) => {
        if (error instanceof AuthorizationDeclinedError) observed.declined = true
        throw error
      }),
      commit: mutate => this.commitRecord(flow.key, owner, mutate),
    })
    owner.flow = running
    void running.then(() => { owner.flowSettled = true }, () => { owner.flowSettled = true })
    try {
      if (await Promise.race([running.then(() => 'ran' as const), withdrawn]) === 'withdrawn') {
        // Withdrawal only fires while the attempt is `active`, so nothing was
        // admitted. Nothing awaits the orphan any more, so its eventual
        // failure has to be marked handled or it would take down the process.
        void running.catch(() => { this.ctx.logger.debug('authorization: withdrawn flow failed after the fact') })
        return { status: 'cancelled' }
      }
    } catch (error) {
      if (signal.aborted || (observed.declined && owner.phase.status === 'active')) {
        // A withdrawn attempt and a declined prompt are outcomes, not
        // failures: the human said no, or closed the page — and only before a
        // commit was admitted. Anything else is the flow failing and belongs
        // to the caller, cause chain intact — a rejected admitted write
        // included.
        return { status: 'cancelled' }
      }
      // A failed flow's owned commits drain before its error propagates: the
      // reservation cannot release while admitted write work is still running.
      await owner.queue.catch(() => {})
      throw error
    }
    owner.flowSettled = true
    // Drain commit work the flow queued before confirming: a fire-and-forget
    // commit inside the run is still this attempt's write. An admitted write's
    // retained storage failure outranks the missing-commit refusal; anything
    // else unresolved is still not committed.
    await owner.queue.catch(() => {})
    if (owner.phase.status === 'failed') throw owner.phase.error
    if (owner.phase.status !== 'committed') {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" resolved without committing a credential record in this attempt`,
        'NOT_COMMITTED')
    }
    const stored = await this.ctx.credentials.describeRecord(flow.key)
    if (!stored.configured) {
      throw new AuthorizationError(
        `authorization flow for "${flow.key}" deleted its credential record instead of committing one`,
        'NOT_COMMITTED')
    }
    return { status: 'authorized' }
  }
}

export default AuthorizationService
