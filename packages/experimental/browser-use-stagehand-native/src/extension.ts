/** Discover an installed Stagehand extension without reloading its service worker. */

import { z } from 'zod'

const installedExtensions = z.looseObject({
  extensions: z.array(z.looseObject({ id: z.string().min(1), name: z.string(), enabled: z.boolean() })),
})

/**
 * Reuse the sole enabled Stagehand extension, or allow the SDK to install an absent one.
 * The temporary CDP connection only reads extension metadata and disconnects before returning.
 * @param endpoint - configured browser debugging endpoint.
 * @param timeoutMs - deadline for connection and metadata discovery.
 * @returns the existing extension id, or undefined when no Stagehand extension is installed.
 */
export async function installedStagehandExtension(endpoint: string, timeoutMs: number): Promise<string | undefined> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs, noDefaults: true })
  let timeout: ReturnType<typeof setTimeout> | undefined
  const discovery = (async () => {
    const session = await browser.newBrowserCDPSession()
    const response: unknown = await session.send('Extensions.getExtensions')
    const installed = installedExtensions.parse(response).extensions.filter(extension => extension.name === 'Stagehand Runtime')
    const enabled = installed.filter(extension => extension.enabled)
    if (enabled.length > 1) throw new Error('Multiple enabled Stagehand extensions are installed; configure extensionId')
    const selected = enabled[0]
    if (selected !== undefined) return selected.id
    if (installed.length > 0) throw new Error('Stagehand extension is installed but disabled')
    return undefined
  })()
  try {
    return await Promise.race([
      discovery,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error('Stagehand extension discovery timed out')) }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    // Closing a Playwright CDP attachment disconnects its transport; it preserves Chromium.
    await browser.close()
    await discovery.catch(() => {})
  }
}
