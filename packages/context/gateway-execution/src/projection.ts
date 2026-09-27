/** Host-only execution constraints reconstructed and maintained by the Session projection registry. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { ExecutionInheritance, ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { executionScope, executionState, hasUnverifiedExecutionInput } from './input.ts'

/** Provider-owned derived state; Gateway records still decide current authorization. */
export interface ExecutionProjectionState {
  readonly state: ExecutionState
  readonly inheritance: ExecutionInheritance | null
  readonly continuation: { readonly key: string; readonly scope: ExecutionInheritance } | null
  readonly scopedProtocol: boolean
  readonly unverified: boolean
  readonly inheritedEventCount: number
  readonly seeded: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'gateway-execution': ExecutionProjectionState
  }
}

/** An empty participant set authorizes no managed execution. */
const EMPTY: ExecutionState = { revision: '0', inputs: [], actors: [], unverifiedHistory: false }
const scopedProtocolSchema = z.object({ version: z.literal(1) }).strict()

/** Identity constraints have no browser projection and never supply permissions. */
export const EXECUTION_PROJECTION: ProjectionDefinition<'gateway-execution'> = {
  key: 'gateway-execution',
  stateVersion: 3,
  stateSchema: z.object({
    state: z.unknown().transform(executionState),
    inheritance: z.unknown().transform(executionScope).nullable(),
    continuation: z.object({ key: z.string(), scope: z.unknown().transform(executionScope) }).strict().nullable(),
    scopedProtocol: z.boolean(),
    unverified: z.boolean(),
    inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    seeded: z.boolean(),
  }).strict(),
  init: (header, inheritedEventCount) => ({
    state: EMPTY, inheritance: null, continuation: null, scopedProtocol: false, unverified: false,
    inheritedEventCount, seeded: header.isSeeded,
  }),
  apply: (previous, event) => {
    if (event.seq < previous.inheritedEventCount) return previous
    if (event.type === 'gateway/scoped-execution') {
      if (!scopedProtocolSchema.safeParse(event.data).success || event.ignorable === true) throw new TypeError('unsupported scoped execution protocol')
      return { ...previous, scopedProtocol: true }
    }
    if (event.type === 'gateway/continuation') {
      const scope = executionScope(event.data.scope)
      if (scope.scopeId !== undefined && !previous.scopedProtocol) throw new TypeError('scoped continuation requires its reader admission event')
      return { ...previous, continuation: { key: event.data.key, scope } }
    }
    if (event.type === 'gateway/execution') {
      switch (event.data.kind) {
        case 'accepted': {
          const state = executionState(event.data.state)
          if (state.scopeId !== undefined && !previous.scopedProtocol) throw new TypeError('scoped execution requires its reader admission event')
          const unverified = state.scopeId === undefined ? previous.unverified || state.unverifiedHistory : state.unverifiedHistory
          return { ...previous, state, unverified }
        }
        case 'inherit': {
          const scope = executionScope(event.data.scope)
          if (scope.scopeId !== undefined && !previous.scopedProtocol) throw new TypeError('scoped inheritance requires its reader admission event')
          return { ...previous, inheritance: scope, unverified: previous.unverified || scope.unverifiedHistory }
        }
        default: return assertNever(event.data)
      }
    }
    if (event.type === 'user/message' && !previous.unverified && hasUnverifiedExecutionInput(event.data)) {
      return { ...previous, unverified: true }
    }
    return previous
  },
}
