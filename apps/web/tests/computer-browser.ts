/** Browser entry for multi-computer acceptance on the local or a tunneled QA device. */
import { chromium, firefox, webkit, type Browser } from 'playwright'
export type { Browser, BrowserContext, Locator, Page, Response as BrowserResponse, Request as BrowserRequest } from 'playwright'

/** A caller-owned browser, independent of Vitest and application server setup. */
export interface ComputerBrowserOptions {
  engine: 'chromium' | 'firefox' | 'webkit'
  executablePath?: string
  cdpEndpoint?: string
}
/** Launch or attach to a dedicated QA browser; never reuse its default context.
 * @param options - explicit engine, executable or loopback CDP endpoint.
 * @returns a connection the caller closes after disposing its own contexts.
 */
export function launchComputerBrowser(options: ComputerBrowserOptions): Promise<Browser> {
  if (!options.cdpEndpoint) return { chromium, firefox, webkit }[options.engine].launch({
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.engine === 'firefox' ? { firefoxUserPrefs: { 'network.proxy.type': 0 } } : {}),
  })
  if (options.engine !== 'chromium' || options.executablePath !== undefined) throw new Error('A dedicated CDP endpoint requires Chromium without executablePath')
  const url = new URL(options.cdpEndpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected a dedicated loopback Chromium debugging endpoint')
  return chromium.connectOverCDP(url.origin)
}
/** Connect to a dedicated Chromium endpoint or launch the selected local engine. */
export function computerBrowser() {
  const engine = process.env.DSH_RESPONSIVE_BROWSER ?? 'chromium'
  if (engine !== 'chromium' && engine !== 'webkit' && engine !== 'firefox') throw new Error('DSH_RESPONSIVE_BROWSER must be chromium, webkit or firefox')
  const endpoint = process.env['DSH_BROWSER_CDP_ENDPOINT']
  const executablePath = process.env['DSH_TEST_BROWSER_EXECUTABLE']
  return launchComputerBrowser({ engine, ...(endpoint === undefined ? {} : { cdpEndpoint: endpoint }),
    ...(executablePath === undefined || endpoint !== undefined ? {} : { executablePath }) })
}
