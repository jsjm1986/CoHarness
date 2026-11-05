/** Browser entry for multi-computer acceptance on the local or a tunneled QA device. */
import { chromium } from 'playwright'

const browserOptions = () => process.env['DSH_TEST_BROWSER_EXECUTABLE'] ? { executablePath: process.env['DSH_TEST_BROWSER_EXECUTABLE'] } : {}
/** Connect to the dedicated platform browser or launch an isolated local Chromium process. */
export function computerBrowser() {
  const endpoint = process.env['DSH_BROWSER_CDP_ENDPOINT']
  if (!endpoint) return chromium.launch(browserOptions())
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Expected a dedicated loopback Chromium debugging endpoint')
  }
  return chromium.connectOverCDP(url.origin)
}
