/** Desktop environment metadata without driver admission or interactive desktop authority. @module */
import type { Context } from '@deepseek-ai/cordis'
import { inspectDesktopEnvironment } from '@deepseek-ai/dsh-native-command'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Managed desktop metadata plugin identity. */
export const name = 'desktop-availability'

/**
 * Observe the local graphical session without starting a driver or requesting OS access.
 * Registered desktop providers retain their own availability and authorization rules.
 * @param ctx - deployment service owner.
 * @returns after read-only inspection and lifecycle-owned metadata registration.
 */
export async function apply(ctx: Context): Promise<void> {
  const environment = await inspectDesktopEnvironment()
  if (ctx.fiber.uid === null) return
  const unavailableReason = environment.state === 'not-detected' ? 'headless' : 'disabled'
  ctx.provide('computerUseEnvironment', { unavailableReason })
  ctx.inject(['systemPrompt'], (inner) => {
    inner.systemPrompt.section({
      name: 'computer-use:environment', order: inner.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: () => {
        if (inner.get('computerUse')?.providerName !== undefined) return ''
        return unavailableReason === 'headless'
          ? 'This server has no detected graphical desktop. Computer Use and local desktop control are unavailable. Do not attempt local desktop actions. File, terminal and separately configured headless-browser tools remain independent.'
          : 'No computer-use desktop driver is enabled in this runtime. Do not attempt desktop actions. File, terminal and separately configured headless-browser tools remain independent.'
      },
    })
  })
}
