/**
 * Per-invocation plan Nodes: one hidden Chat Node per `exit_plan_mode`
 * invocation keeps the submitted plan readable in the per-Session node
 * store, where the Turn-tail cards and the Sidebar reader resolve it.
 */
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the dsh-tools SessionEventMap merge (`tool/ptc-dispatch*`).
import type {} from '@deepseek-ai/dsh-tools/types'
import type {
  ChatSnapshot, ConversationNodeDefinition, ConversationSnapshot, ObservableSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import { submittedPlan, type SubmittedPlan } from './plan.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Complete plan submitted through `exit_plan_mode`, including rejected or dismissed reviews. */
    'submitted-plan': SubmittedPlan
  }
}

/**
 * Collect one Turn's submitted plans in invocation order. Hidden Nodes stay
 * in the node store while staying out of `order` and the Location index, so
 * this scans the materialized set rather than a visible-only index.
 * @param chat - current Chat snapshot.
 * @param turn - Turn number owning the plans.
 * @returns submitted plans anchored inside the Turn, by anchor seq.
 */
export function plansForTurn(chat: ChatSnapshot, turn: number): readonly SubmittedPlan[] {
  const plans: { readonly seq: number; readonly plan: SubmittedPlan }[] = []
  for (const node of chat.nodes.values()) {
    if (node.kind !== 'submitted-plan') continue
    const owner = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn.turn : undefined
    if (owner === turn) plans.push({ seq: node.anchorSeq, plan: (node as ChatNode<'submitted-plan'>).data })
  }
  return plans.sort((left, right) => left.seq - right.seq).map(({ plan }) => plan)
}

/**
 * Observe one Turn's submitted plans through the owning Session's Chat
 * window. The derived source forwards the Session's commit cadence and
 * republishes its value only when the Turn's plan list changes, so
 * streaming flushes do not churn card subscribers.
 * @param session - bound Session snapshot face.
 * @param turn - Turn number owning the plans.
 * @returns stable plans collection for the keyed Hook binding.
 */
export function plansSourceFor(
  session: ObservableSnapshot<ConversationSnapshot>,
  turn: number,
): ObservableSnapshot<readonly SubmittedPlan[]> {
  let cached: readonly SubmittedPlan[] | undefined
  return {
    getSnapshot: () => {
      const plans = plansForTurn(session.getSnapshot().chat, turn)
      const stable = cached !== undefined && cached.length === plans.length
        && cached.every((plan, index) => plan === plans[index])
      if (!stable) cached = plans
      return cached as readonly SubmittedPlan[]
    },
    subscribe: listener => session.subscribe(listener),
  }
}

/** One card per invocation; a later PTC settlement retains the original card position. */
export const submittedPlanDefinition: ConversationNodeDefinition<SubmittedPlan> = {
  kind: 'submitted-plan',
  target: 'chat',
  match: (event) => {
    const plan = submittedPlan(event)
    return plan === undefined ? null : { id: plan.callId, role: event.type === 'tool/ptc-dispatch' ? 'update' : 'start' }
  },
  start: (_context, match) => submittedPlan(match.event) as SubmittedPlan,
  update: context => context.state,
  buildViewNode: (context) => {
    const start = context.start ?? context.matches[0]
    const data = context.state ?? (start === undefined ? undefined : submittedPlan(start.event))
    if (data === undefined || start === undefined) return null
    return {
      key: context.key, kind: 'submitted-plan', id: context.id, target: 'chat',
      anchorSeq: start.event.seq, location: start.location,
      visibility: 'hidden', data,
    } satisfies ChatNode<'submitted-plan'>
  },
}
