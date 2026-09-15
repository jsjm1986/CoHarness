/** Project collaboration capability Service Definition. @module @deepseek-ai/dsh-collaboration */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CollaborationAction,
  CollaborationAuthority,
  CollaborationErrorCode,
  CollaborationRefusal,
  CollaborationSessionCreation,
} from './types.ts'

export * from './types.ts'

/**
 * Build the stable RPC refusal shared by every collaboration enforcement point.
 * @param error - failure raised by the collaboration authority or transport.
 * @param action - operation the caller attempted.
 * @param sessionId - optional session associated with the operation.
 * @returns a wire-safe refusal with a stable code, message, and reason.
 */
export function collaborationRefusal(
  error: unknown,
  action: CollaborationAction,
  sessionId?: SessionId,
): CollaborationRefusal {
  const reason = error instanceof CollaborationError ? error.code : 'gateway-unavailable'
  const message = reason === 'conversation-not-found'
    ? 'Conversation is unavailable.'
    : reason === 'not-member'
      ? 'You are not a member of this project.'
      : reason === 'visibility-locked'
        ? 'Conversation visibility cannot be changed after another participant contributes.'
        : reason === 'gateway-unavailable'
          ? 'Collaboration authorization is temporarily unavailable.'
          : 'You do not have permission to perform this action.'
  return {
    code: 'collaboration-forbidden',
    message,
    details: { action, reason, ...(sessionId === undefined ? {} : { sessionId }) },
  }
}

/**
 * Build the shared refusal as a RemoteError for Typert Remote services.
 * The code deliberately matches the RPC refusal so client denial handling
 * does not fork by transport.
 * @param error - failure raised by the collaboration authority or transport.
 * @param action - operation the caller attempted.
 * @param sessionId - optional session associated with the operation.
 * @returns the refusal as a RemoteError preserving the RPC wire code.
 */
export function collaborationRemoteRefusal(
  error: unknown,
  action: CollaborationAction,
  sessionId?: SessionId,
): RemoteError<'collaboration-forbidden'> {
  const refusal = collaborationRefusal(error, action, sessionId)
  return new RemoteError('collaboration-forbidden', refusal.message, refusal.details, { cause: error })
}


/** Collaboration denial or provider failure with a stable machine-readable code. */
export class CollaborationError extends Error {
  /**
   * Create one collaboration failure.
   * @param code - stable denial or provider failure code.
   * @param message - optional diagnostic override.
   */
  constructor(readonly code: CollaborationErrorCode, message: string = code) {
    super(message)
    this.name = 'CollaborationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    collaboration: Collaboration
  }
}

/** Project collaboration Service Definition consumed by host APIs and persistence providers. */
export abstract class Collaboration extends Service {
  constructor(ctx: Context) {
    super(ctx, 'collaboration')
  }

  /**
   * Capture the authenticated principal for one request or event stream.
   * @returns an authority with participant identity and collaboration operations.
   */
  abstract capture(): CollaborationAuthority

  /**
   * Return new-session metadata visible during the wrapped creation operation.
   * @returns the active creation metadata, or undefined outside a wrapped operation.
   */
  abstract currentCreation(): CollaborationSessionCreation | undefined

  /**
   * Run session creation under an authenticated visibility choice.
   * @param creation - requested root-conversation visibility.
   * @param operation - creation work that synchronously reaches persistence registration.
   * @returns the operation result.
   */
  abstract withSessionCreation<T>(
    creation: CollaborationSessionCreation,
    operation: () => Promise<T>,
  ): Promise<T>
}

export default Collaboration
