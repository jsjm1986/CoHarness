/** Human confirmation for the configured desktop of one live root workflow. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopConfirmation } from '@deepseek-ai/dsh-computer-use/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

export type { DesktopConfirmation } from '@deepseek-ai/dsh-computer-use/types'

/** All methods use the authenticated browser principal, never a model-provided actor. */
export interface DesktopApi {
  /**
   * Read the current user's desktop qualification and consent.
   * @param request - exact pane Session.
   * @param signal - request lifetime.
   * @returns the live root target, or null when no managed desktop policy is configured.
   */
  status(request: RpcRequest<{ sessionId: SessionId }>, signal?: AbortSignal): Promise<RpcResponse<DesktopConfirmation | null>>
  /**
   * Save an explicit user gesture for the exact target that the page displayed.
   * @param request - pane, expected root/node/desktop and confirm-or-withdraw choice.
   * @param signal - request lifetime.
   * @returns current personal confirmation after the save; stale targets are refused.
   */
  confirm(request: RpcRequest<{ sessionId: SessionId; rootSessionId: SessionId; nodeId: string; desktop: string; confirmed: boolean }>,
    signal?: AbortSignal): Promise<RpcResponse<DesktopConfirmation>>
}
