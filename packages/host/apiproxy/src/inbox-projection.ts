/** Durable pending-input projection for Agent-free Session history reads. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'
import type { QueuedInboxItem } from './api/events.ts'
import { queuedInboxItemsSchema } from './api/events.schema.ts'

type State = SessionProjectionStateMap['inbox']

/** Reconstruct only the Session's own inbox; inherited messages belong to its parent. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateVersion: 1,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative(),
    items: queuedInboxItemsSchema,
  }),
  init: (_header, inheritedEventCount): State => ({ inheritedEventCount, items: [] }),
  apply: (state, event): State => {
    if (event.seq < state.inheritedEventCount || event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    const inserted: QueuedInboxItem[] = splice.inserted.map(message => ({
      id: message.id,
      ...(message.source.kind === 'user' && 'rpcId' in message.source ? { rpcId: message.source.rpcId } : {}),
      message,
      placement: splice.target === 'next-turn' ? 'queued' : message.source.kind === 'user' ? 'steering' : 'context',
    }))
    const key = splice.target === 'next-turn' ? 'queued' : 'nextStep'
    const lists = {
      queued: state.items.filter(item => item.placement === 'queued'),
      nextStep: state.items.filter(item => item.placement !== 'queued'),
    }
    const previous = lists[key]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || !Number.isSafeInteger(removedCount)
      || splice.start < 0 || splice.start > previous.length
      || removedCount < 0 || removedCount > previous.length - splice.start) {
      throw new Error('invalid persisted inbox splice range')
    }
    lists[key] = previous.toSpliced(splice.start, removedCount, ...inserted)
    const next = { ...state, items: [...lists.queued, ...lists.nextStep] }
    if (new Set(next.items.map(item => item.id)).size !== next.items.length) throw new Error('duplicate persisted inbox message identity')
    return next
  },
  wire: { viewSchema: queuedInboxItemsSchema, view: (state): QueuedInboxItem[] => state.items },
} satisfies ProjectionDefinition<'inbox'>
