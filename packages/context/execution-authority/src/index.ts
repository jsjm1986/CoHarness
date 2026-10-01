/** Verified execution identity Service Definition. @module @deepseek-ai/dsh-execution-authority */
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ExecutionCapability, ExecutionInheritance, ExecutionQuestionId, ExecutionState } from './types.ts'

export type { ExecutionCapability, ExecutionInheritance, ExecutionInputId, ExecutionQuestionId, ExecutionScopeId, ExecutionState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    executionAuthority: ExecutionAuthority
    /** A managed deployment must never fall back to unverified local authority. */
    executionAuthorityRequired: boolean
  }
}

/** Authority operations shared by input transports, delegated work, and privilege consumers. */
export abstract class ExecutionAuthority extends Service {
  constructor(ctx: Context) {
    if (new.target === ExecutionAuthority) throw new Error('execution-authority requires a concrete provider')
    super(ctx, 'executionAuthority')
  }

  /**
   * Attest the live caller and exact human input, retaining all earlier editors.
   * @param session - Session which owns the input.
   * @param message - content and display metadata accepted by the input transport.
   * @returns immutable input with verified origin reference.
   */
  abstract stamp(session: Session, message: UserMessage): Promise<UserMessage>

  /**
   * Claim a verified human answer and include its responder before delivery.
   * @param session - Session owning the live question.
   * @param questionId - exact pending question identity verified by the transport.
   * @param answer - parser-validated answer.
   * @param scope - exact execution captured when the question opened.
   * @returns whether the caller owns this answer, including an identical retry.
   */
  abstract answer(session: Session, questionId: ExecutionQuestionId, answer: unknown, scope?: ExecutionInheritance): Promise<boolean>

  /**
   * Preserve captured execution identity across an asynchronous callback.
   * @param agent - exact lifecycle owner of the operation.
   * @param scope - participants captured when the work was admitted.
   * @param work - callback that must not borrow a later request's identity.
   * @returns the callback result.
   */
  abstract runCaptured<T>(agent: Agent, scope: ExecutionInheritance, work: () => T): T

  /**
   * Attest a live human command before it creates background execution.
   * @param agent - target authorized by the calling transport.
   * @param input - exact command or Remote invocation to attribute.
   * @param work - operation executed under the verified initiator.
   * @returns the operation result.
   */
  abstract runRequest<T>(agent: Agent, input: unknown, work: () => T): Promise<Awaited<T>>

  /**
   * Capture the current participants before awaiting delegated work.
   * @param agent - exact live parent Agent.
   * @returns immutable inheritance for the new or continued child.
   */
  abstract capture(agent: Agent): ExecutionInheritance

  /**
   * Capture the current execution of a cold or live source for an explicit fork.
   * @param sessionId - source already authorized by the fork transport.
   * @returns current execution references, independently of the selected history cut.
   */
  abstract captureSession(sessionId: SessionId): Promise<ExecutionInheritance>

  /**
   * Persist captured restrictions in the child's own log.
   * @param session - child Session, including the unpublished setup window.
   * @param scope - participants captured from its actual parent.
   */
  abstract inherit(session: Session, scope: ExecutionInheritance): void

  /**
   * Include an adjacent sender's restrictions before admitting its durable delivery.
   * @param session - actual recipient, including a Team's routing host.
   * @param scope - sender facts captured before asynchronous delivery.
   * @param messageId - stable delivery identity for retry deduplication.
   * @param signal - delivery cancellation.
   * @returns recipient restrictions for an onward delegation of this delivery.
   */
  abstract relay(session: Session, scope: ExecutionInheritance, messageId: MessageId, signal?: AbortSignal): Promise<ExecutionInheritance>

  /**
   * Recheck every participant against current permissions.
   * @param capability - required privilege; identity alone grants none.
   * @param agent - actual executing Agent.
   * @param signal - operation-owned cancellation.
   * @param execution - exact tool call when authorization precedes other execution wrappers.
   * @returns verified participants for attribution; one call incurs one charge.
   */
  abstract authorize(capability: ExecutionCapability, agent: Agent, signal?: AbortSignal,
    execution?: ToolExecution): Promise<ExecutionState>

  /**
   * Authorize an explicit preset selection before its synchronous commit.
   * @param agent - target Agent.
   * @param preset - requested preset name.
   */
  abstract authorizeSelection(agent: Agent, preset: string): Promise<void>
}

/**
 * Resolve managed authority without treating missing configuration as local access.
 * @param ctx - consumer's owning Context.
 * @returns the provider, or absence in an independent local deployment.
 */
export function executionAuthorityOf(ctx: Context): ExecutionAuthority | undefined {
  const authority = ctx.get('executionAuthority')
  if (authority === undefined && ctx.get('executionAuthorityRequired') === true) {
    throw new RemoteError('execution/forbidden', 'Managed execution requires its authorization provider.', { capability: 'execute' })
  }
  return authority
}

/**
 * Compare providers across Cordis reads without confusing fresh tracing proxies with replacement.
 * @param current - provider resolved after asynchronous authorization.
 * @param captured - provider that performed authorization before the final mutation.
 * @returns whether both reads refer to the same provider, including local absence.
 */
export function sameExecutionAuthority(current: ExecutionAuthority | undefined, captured: ExecutionAuthority | undefined): boolean {
  const original = (value: ExecutionAuthority | undefined) =>
    (value as (ExecutionAuthority & { [symbols.original]?: ExecutionAuthority }) | undefined)?.[symbols.original] ?? value
  return original(current) === original(captured)
}

export default ExecutionAuthority
