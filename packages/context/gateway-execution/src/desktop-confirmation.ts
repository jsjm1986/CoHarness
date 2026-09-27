/** Interactive desktop confirmation, separate from model approval and execution witnesses. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DesktopConfirmationController } from '@deepseek-ai/dsh-computer-use'
import { readGatewayResponseJson, type GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'

const status = z.object({ rootSessionId: z.string().min(1).transform(SessionId), nodeId: z.string().min(1),
  desktop: z.string().min(1), userId: z.number().int().positive(), eligible: z.boolean(), confirmed: z.boolean() }).strict()

/**
 * Bind explicit human gestures to the live root and configured desktop.
 * @param runtime - interactive principal and authenticated Gateway transport.
 * @param root - live Agent ownership resolver.
 * @param desktop - deployment-owned resource identifier.
 * @returns current-user confirmation operations; absent or restricted principals are refused.
 */
export function desktopConfirmationController(runtime: Pick<GatewayRuntime, 'interactive' | 'request'>,
  root: (agent: Agent) => Agent, desktop: string): DesktopConfirmationController {
  const principal = () => {
    const value = runtime.interactive()
    if (value === undefined || value.claims.purpose !== undefined || value.claims.expiresAt <= Date.now()) {
      throw new Error('Desktop confirmation requires an active human request.')
    }
    return value
  }
  const controller: DesktopConfirmationController = {
    async read(agent, signal) {
      signal.throwIfAborted()
      const owner = root(agent), user = principal()
      const response = await runtime.request('/internal/runtime/execution/desktop-confirmation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: owner.id, desktop }), principal: user, signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Desktop confirmation is unavailable for this account.')
      }
      const value = status.parse(await readGatewayResponseJson(response, undefined, signal))
      if (root(agent) !== owner || value.rootSessionId !== owner.id || value.desktop !== desktop || value.userId !== user.claims.user.id) {
        throw new Error('Desktop confirmation target changed; refresh before continuing.')
      }
      return value
    },
    async set(agent, expected, confirmed, signal) {
      signal.throwIfAborted()
      const owner = root(agent), user = principal()
      if (expected.rootSessionId !== owner.id || expected.desktop !== desktop) {
        throw new Error('Desktop confirmation target changed; refresh before continuing.')
      }
      const response = await runtime.request('/internal/runtime/execution/desktop-confirm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: owner.id, desktop, expectedNodeId: expected.nodeId, confirmed }), principal: user, signal,
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Desktop confirmation was not saved; refresh its current status.')
      }
      z.object({ saved: z.literal(true) }).parse(await readGatewayResponseJson(response, undefined, signal))
      if (root(agent) !== owner) throw new Error('Desktop confirmation target changed; refresh before continuing.')
      return controller.read(agent, signal)
    },
  }
  return controller
}
