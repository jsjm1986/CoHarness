/** Durable model-selection intent and request-use projection. */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  ModelSelection,
  ModelSelectionProjection,
  ModelSelectionProjectionState,
} from './api/sessions.ts'
import { modelSelectionSchema } from './api/sessions.schema.ts'

const modelSelectionProjectionStateSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  pending: modelSelectionSchema.nullable(),
}) as unknown as z.ZodType<ModelSelectionProjectionState>

const modelSelectionProjectionSchema = z.object({
  lastUsed: modelSelectionSchema.nullable(),
  next: modelSelectionSchema.nullable(),
}) as unknown as z.ZodType<ModelSelectionProjection>

function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return left === right || (left !== null && right !== null
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

/**
 * Advance durable model-selection state by one Session event.
 * @param state - selection state before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced selection state.
 */
function applyModelSelectionProjection(
  state: ModelSelectionProjectionState,
  event: SessionEvent,
): ModelSelectionProjectionState {
  if (event.type === 'model/selection') {
    return sameSelection(state.pending, event.data)
      ? state
      : { lastUsed: state.lastUsed, pending: event.data }
  }
  if (event.type !== 'request/header') return state
  const lastUsed: ModelSelection = {
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    ...(event.data.header.config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(event.data.header.config.reasoningEffort) }),
  }
  const pending = sameSelection(state.pending, lastUsed) ? null : state.pending
  return sameSelection(state.lastUsed, lastUsed) && pending === state.pending
    ? state
    : { lastUsed, pending }
}

/** Fold and wire view for the durable model-selection projection unit. */
export const modelSelectionProjectionDefinition = {
  key: 'modelSelection',
  stateSchema: modelSelectionProjectionStateSchema,
  init: () => ({ lastUsed: null, pending: null }),
  apply: applyModelSelectionProjection,
  wire: {
    viewSchema: modelSelectionProjectionSchema,
    view: state => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }),
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'modelSelection', ModelSelectionProjectionState>
