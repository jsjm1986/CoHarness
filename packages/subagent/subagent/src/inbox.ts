/**
 * Activation-local admission around one continuable subagent's Agent inbox.
 *
 * @module @deepseek-ai/dsh-subagent/inbox
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequest } from './control-types.ts'
import { SubagentError } from './error.ts'
import type { StructuredAttachment } from './structured.ts'

/** One Agent inbox destination, as the wire request selects it. */
export type SubagentDelivery = SubagentPromptRequest['delivery']

/** Delegate Queue and Steer to one live Agent until its Activation starts closing. */
export class SubagentInbox {
  private closingPromise: Promise<void> | undefined

  /**
   * Wrap one live continuable Agent.
   * @param agent - the Agent whose inbox receives accepted deliveries.
   * @param structured - this epoch's structured attachment, whose staged or
   *   committed capture closes child-bound input until its result resolves.
   */
  constructor(
    private readonly agent: Agent,
    private readonly structured?: StructuredAttachment,
  ) {}

  /**
   * Read the Activation's close transaction.
   * @returns the memoized transaction, or `undefined` while delivery remains open.
   */
  get closing(): Promise<void> | undefined {
    return this.closingPromise
  }

  /**
   * Read whether the underlying Agent still has accepted work to claim.
   * @returns whether either Agent inbox destination is non-empty.
   */
  get hasPending(): boolean {
    return this.agent.inbox.nextTurn.length > 0 || this.agent.inbox.nextStep.length > 0
  }

  /**
   * Submit through the Agent only while its Activation remains resident.
   * @param message - the accepted input to submit.
   * @param delivery - whether to queue a distinct turn or steer the nearest step.
   */
  deliver(message: UserMessage, delivery: SubagentDelivery): void {
    if (this.closingPromise !== undefined) {
      throw new SubagentError(
        `subagent "${this.agent.id}" activation is being disposed; the message was not accepted`,
        'ACTIVATION_CLOSING',
      )
    }
    if (this.structured?.acceptsInput() === false) {
      throw new SubagentError('subagent is submitting or has submitted its structured result; the message was not accepted', 'INPUT_CLOSED')
    }
    if (delivery === 'steer') this.agent.steer(message)
    else this.agent.followup(message)
  }

  /**
   * Close delivery synchronously and share one asynchronous release.
   * @param release - the one release operation to start after closing admission.
   * @returns the memoized release transaction.
   */
  close(release: () => Promise<void>): Promise<void> {
    const existing = this.closingPromise
    if (existing !== undefined) return existing
    const completion = Promise.withResolvers<undefined>()
    this.closingPromise = completion.promise
    void release().then(() => { completion.resolve(undefined) }, completion.reject)
    return completion.promise
  }
}
