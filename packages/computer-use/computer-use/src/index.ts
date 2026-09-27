/**
 * Exclusive named registration for the computer-use capability.
 * @module @deepseek-ai/dsh-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DesktopConfirmation } from './types.ts'
export type { DesktopConfirmation } from './types.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-execution-authority'
import type { ComputerUseProviderName } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computerUse: ComputerUseRegistry
    /** Deployment-owned desktop permission, confirmation and lease enforcement. */
    computerUseAuthorization: ComputerUseAuthorization
  }
}

/** The desktop policy owns authorization and the lease for the complete driver call. */
export interface ComputerUseAuthorization {
  /** Optional interactive confirmation owner; tools cannot impersonate its user. */
  readonly confirmation?: DesktopConfirmationController | undefined
  /**
   * Verify the actual actor, then hold desktop authority until the call settles.
   * @param execution - exact tool execution, including its live Agent and cancellation.
   * @param operation - driver effect; the supplied signal also carries revocation and lease loss.
   * @returns the result only while the grant remains valid; cleanup is awaited on rejection.
   */
  run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** User gestures remain distinct from model approval and execution authority. */
export interface DesktopConfirmationController {
  /**
   * Read current-user eligibility and confirmation for the caller's live root.
   * @param agent - exact active pane's Agent.
   * @param signal - request cancellation.
   * @returns the server's current root, desktop and personal confirmation.
   */
  read(agent: Agent, signal: AbortSignal): Promise<DesktopConfirmation>
  /**
   * Confirm or withdraw only the interactive user's decision for the displayed target.
   * @param agent - exact active pane's Agent.
   * @param expected - root, node and desktop displayed before the gesture.
   * @param confirmed - explicit user choice.
   * @param signal - request cancellation.
   * @returns the freshly read confirmation after saving.
   */
  set(agent: Agent, expected: Pick<DesktopConfirmation, 'rootSessionId' | 'nodeId' | 'desktop'>,
    confirmed: boolean, signal: AbortSignal): Promise<DesktopConfirmation>
}

/** Owns one optional provider registration in the shared computer-use service. */
export class ComputerUseRegistry extends Service {
  private registration: ComputerUseProviderName | undefined
  private managed = false

  constructor(ctx: Context) {
    super(ctx, 'computerUse')
  }

  /**
   * Execute a driver call under the deployment's desktop policy.
   * Managed runtimes never recover local desktop authority when their policy unloads.
   * @param execution - actual tool caller and cancellation.
   * @param operation - native or MCP operation after authorization.
   * @returns the authorized driver result.
   */
  async run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    execution.signal.throwIfAborted()
    this.managed ||= this.ctx.get('executionAuthorityRequired') === true || this.ctx.get('executionAuthority') !== undefined
    const authorization = this.ctx.get('computerUseAuthorization')
    if (this.managed && (authorization === undefined || execution.agent === undefined)) {
      throw new Error('Managed desktop access requires an authorized Session and an active desktop policy.')
    }
    const invoke = async (signal: AbortSignal): Promise<T> => {
      const combined = AbortSignal.any([execution.signal, signal])
      combined.throwIfAborted()
      const result = await operation(combined)
      combined.throwIfAborted()
      return result
    }
    return authorization === undefined ? invoke(execution.signal) : authorization.run(execution, invoke)
  }

  /** Name of the registered provider, including while its resources are closing. */
  get providerName(): ComputerUseProviderName | undefined {
    return this.registration
  }

  /**
   * Reserve the sole provider slot until the contribution is disposed.
   * A second registration fails even when it repeats the current name. Providers
   * must stop their tools and await owned work before releasing this registration.
   * @param name - provider-owned name used in registration diagnostics.
   * @returns the effect disposer for this exact registration.
   */
  register(name: ComputerUseProviderName): () => Promise<void> {
    if (this.registration !== undefined) {
      throw new Error(`computer use provider "${this.registration}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.registration = name
      return () => {
        this.registration = undefined
      }
    }, 'computerUse.register()')
  }
}

export default ComputerUseRegistry
