/**
 * Read immutable plan arguments through the Session-owned call-history
 * channel: the Server resolves the exact invocation by callId and the
 * registered Conversation definitions re-assemble it, so the preview never
 * touches the visible history window. Reads ride `sessions.retain`, which
 * owns generation lifetime and direct-subagent addressing.
 */
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionReference } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { parsePlanAddress, type PlanAddress, type SubmittedPlan } from './plan.ts'

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface SessionReferenceSourceMap {
    /** Plan-preview history reads retaining the addressed Session. */
    planPreview: true
  }
}

/** A failed plan read's stable diagnostic. */
export interface PlanFailure {
  readonly code: string
  readonly message: string
}

/** One address's read state: nothing publishes until a load is requested. */
export type PlanRead =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly plan: SubmittedPlan }
  | { readonly status: 'failed'; readonly failure: PlanFailure }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fetch-once cache of history-served plans keyed by resource address: one
 * read per address while a state stands, cleared on connection replacement,
 * cancelled on disposal.
 */
export class PlanReadStore {
  /** Published per-address plan reads for the current connection generation. */
  readonly state = createSnapshotStore<Record<string, PlanRead | undefined>>({})
  private readonly lifetime = new AbortController()
  /** The connection generation the current states belong to; a reset aborts it so no older read publishes. */
  private generation = new AbortController()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly sessions: ISessions) {}

  /**
   * Read one address unless a state already stands for it.
   * @param address - the plan resource address a Sidebar body is showing.
   * @returns after the read settles; the state it publishes carries the outcome.
   */
  load(address: string): Promise<void> {
    const current = this.state.getSnapshot()[address]
    if (this.lifetime.signal.aborted || current !== undefined) return Promise.resolve()
    this.state.update((state) => { state[address] = { status: 'loading' } })
    const task = this.read(address, AbortSignal.any([this.lifetime.signal, this.generation.signal]))
    this.pending.add(task)
    return task.finally(() => { this.pending.delete(task) })
  }

  /** Forget every state and abandon in-flight reads; a replaced connection may reach a Host that no longer serves them. */
  reset(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.state.set({})
  }

  /** Cancel outstanding reads and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.state.set({})
    await Promise.all(this.pending)
  }

  private async read(address: string, signal: AbortSignal): Promise<void> {
    let next: PlanRead
    const target = parsePlanAddress(address)
    if (target === undefined) {
      next = { status: 'failed', failure: { code: 'plan/invalid-address', message: 'The plan address is malformed.' } }
    } else {
      try {
        const found = await this.readPlan(target, signal)
        next = 'plan' in found
          ? { status: 'ready', plan: found.plan }
          : { status: 'failed', failure: found }
      } catch (error) {
        // An aborted read publishes nothing; the stale generation must not overwrite a newer state.
        if (signal.aborted) return
        next = { status: 'failed', failure: { code: 'plan/read-failed', message: messageOf(error) } }
      }
    }
    if (!signal.aborted) this.state.update((state) => { state[address] = next })
  }

  private async readPlan(target: PlanAddress, signal: AbortSignal): Promise<{ plan: SubmittedPlan } | PlanFailure> {
    signal.throwIfAborted()
    const session = target.session
    const resolved: SessionTarget | undefined = session.kind === 'session'
      ? session.sessionId
      : session.mode === 'unknown' ? undefined
        : { parentSessionId: session.parentSessionId, childSessionId: session.childSessionId, mode: session.mode }
    if (resolved === undefined) return { code: 'plan/unavailable', message: 'The Session this plan belongs to cannot be resolved.' }
    let reference: SessionReference
    try {
      reference = this.sessions.retain(resolved, { source: 'planPreview', signal })
      await reference.ready
    } catch (error) {
      if (signal.aborted) throw error
      return { code: 'plan/unavailable', message: messageOf(error) }
    }
    try {
      const snapshot = await reference.binding.session.readCallHistory(target.callId, signal)
      signal.throwIfAborted()
      for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'submitted-plan') continue
        const plan = (node as ChatNode<'submitted-plan'>).data
        if (plan.callId === target.callId) return { plan }
      }
      return { code: 'plan/not-found', message: 'The submitted plan was not found in this Session.' }
    } catch (error) {
      if (signal.aborted) throw error
      return { code: 'plan/read-failed', message: messageOf(error) }
    } finally {
      reference.release()
    }
  }
}
