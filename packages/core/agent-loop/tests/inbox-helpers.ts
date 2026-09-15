import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type Inbox } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ReactLoopInbox } from '../src/inbox.ts'

/**
 * Replace one stub agent's inbox with the durable session-backed implementation.
 * The stub's own registry is used when mounted; otherwise a detached registry
 * on a throwaway context folds the session log on demand — reads replay the
 * log, so `stateOf` stays current without registering a service on the test
 * context (a registry mounted there would change what `ctx.get` observes).
 * @param agent - stub agent whose `inbox` placeholder is replaced.
 * @returns the installed inbox.
 */
export function sessionBackedInbox(agent: Agent): ReactLoopInbox {
  const ctx: Context = agent.ctx
  const projections = ctx.get('sessionProjections') ?? new SessionProjectionRegistry(new Context())
  const inbox = new ReactLoopInbox(projections, agent.session, agentEvents(ctx, agent))
  Object.assign(agent, { inbox })
  return inbox
}

/**
 * Create an unsupported Inbox placeholder for Agent stubs whose tests do not exercise Inbox behavior.
 * @returns an Inbox whose pending lists are empty and whose mutation methods throw.
 */
export function unsupportedInbox(): Inbox {
  const rejectMutation = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [],
    nextStep: [],
    clear: rejectMutation,
    append: rejectMutation,
    prepend: rejectMutation,
    replace: rejectMutation,
    remove: rejectMutation,
    splice: rejectMutation,
  }
}
