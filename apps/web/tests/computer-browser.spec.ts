/** Launcher decisions only; these checks never acquire a browser or a debugging connection. */
import { afterEach, expect, it, vi } from 'vitest'

const engines = vi.hoisted(() => ({
  chromium: { launch: vi.fn(async () => ({})), connectOverCDP: vi.fn(async () => ({})) },
  firefox: { launch: vi.fn(async () => ({})) }, webkit: { launch: vi.fn(async () => ({})) },
}))
vi.mock('playwright', () => engines)
import { computerBrowser, launchComputerBrowser } from './computer-browser.ts'

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

it('launches only the explicit local engine and preserves Firefox loopback isolation', async () => {
  await launchComputerBrowser({ engine: 'firefox', executablePath: '/qa/firefox' })
  expect(engines.firefox.launch).toHaveBeenCalledWith({ executablePath: '/qa/firefox', firefoxUserPrefs: { 'network.proxy.type': 0 } })
  expect(engines.chromium.launch).not.toHaveBeenCalled()
  await launchComputerBrowser({ engine: 'webkit' })
  expect(engines.webkit.launch).toHaveBeenCalledWith({})
})

it('attaches only to an explicit dedicated loopback Chromium endpoint', async () => {
  await launchComputerBrowser({ engine: 'chromium', cdpEndpoint: 'http://127.0.0.1:19222' })
  expect(engines.chromium.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:19222')
  expect(engines.chromium.launch).not.toHaveBeenCalled()
  for (const cdpEndpoint of ['https://127.0.0.1:19222', 'http://public.example:19222', 'http://secret@127.0.0.1:19222', 'http://127.0.0.1:19222/user-context']) {
    expect(() => launchComputerBrowser({ engine: 'chromium', cdpEndpoint })).toThrow()
  }
  expect(() => launchComputerBrowser({ engine: 'webkit', cdpEndpoint: 'http://127.0.0.1:19222' })).toThrow()
  expect(() => launchComputerBrowser({ engine: 'chromium', cdpEndpoint: 'http://127.0.0.1:19222', executablePath: '/qa/chrome' })).toThrow()
})

it('keeps the existing fixture environment wrapper separate from explicit manual inputs', async () => {
  vi.stubEnv('DSH_RESPONSIVE_BROWSER', 'webkit')
  vi.stubEnv('DSH_BROWSER_CDP_ENDPOINT', undefined)
  vi.stubEnv('DSH_TEST_BROWSER_EXECUTABLE', '/qa/webkit')
  await computerBrowser()
  expect(engines.webkit.launch).toHaveBeenCalledWith({ executablePath: '/qa/webkit' })
  vi.stubEnv('DSH_RESPONSIVE_BROWSER', 'unknown')
  expect(() => computerBrowser()).toThrow()
})
