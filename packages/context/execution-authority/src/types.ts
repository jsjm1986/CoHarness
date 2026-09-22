/** Durable references to Gateway-verified human input; references never grant permissions. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Immutable input identity in the Gateway's execution registry. */
export type ExecutionInputId = Branded<'ExecutionInputId'>

/** Host RPC identity of the pending human question claimed by the Gateway. */
export type ExecutionQuestionId = Branded<'rpc-id'>

/** Privilege checked against every current execution participant. */
export type ExecutionCapability = 'execute' | 'plugin-management' | 'auto-review'

/** Gateway-confirmed participant set, with bounded identity witnesses. */
export interface ExecutionState {
  readonly revision: string
  readonly inputs: readonly ExecutionInputId[]
  readonly actors: readonly { readonly userId: number }[]
  readonly primaryActorUserId?: number
  readonly unverifiedHistory: boolean
}

/** A delegation captures its parent before awaiting child creation. */
export interface ExecutionInheritance {
  readonly parentSessionId: SessionId
  readonly inputs: readonly ExecutionInputId[]
  readonly unverifiedHistory: boolean
  readonly primaryActorUserId?: number
}

/** Persisted authority mirrors record accepted facts or an explicit delegation. */
export type ExecutionEvent =
  | { readonly kind: 'accepted'; readonly state: ExecutionState }
  | { readonly kind: 'inherit'; readonly scope: ExecutionInheritance }

declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    /** Verified billing identity; not model-visible content or an authorization grant. */
    executionIdentity?: {
      readonly inputs: readonly ExecutionInputId[]
      readonly primaryActorUserId?: number
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Verified execution participants and captured delegation; omission loses authorization constraints. */
    'gateway/execution': ExecutionEvent
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The managed execution lacks a verified identity or current required permission. */
    'execution/forbidden': { readonly capability: ExecutionCapability }
  }
}
