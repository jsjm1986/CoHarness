/** Model controls recover from failed HTTP delivery through the shipped Host and built Client. */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Request } from 'playwright'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))
const EXPECTED = new URL('./expected/model-transport-recovery/', import.meta.url)
const MODE = webSnapshotMode()
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined

afterEach(async () => {
  const failures: unknown[] = []
  await page?.unrouteAll({ behavior: 'wait' }).catch((error: unknown) => failures.push(error))
  await browser?.close().catch((error: unknown) => failures.push(error))
  page = undefined
  browser = undefined
  await scaffold?.close().catch((error: unknown) => failures.push(error))
  scaffold = undefined
  if (failures.length > 0) throw new AggregateError(failures, 'Model recovery fixture teardown failed')
})

/** Create one ordinary Session with two declared routes and no model execution. */
async function createWorld(name: string) {
  scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
    providers: {
      'origin-gateway': { displayName: 'Origin Gateway', api: 'openai-completions', baseURL: 'https://origin.synthetic.invalid/v1',
        models: [{ id: 'origin-large', name: 'Origin Large' }] },
      'acme-gateway': { displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.synthetic.invalid/v1',
        models: [{ id: 'acme-large', name: 'Acme Large' }] },
    },
  })
  const sessionId = SessionId(`model-transport-${name}`)
  const created = await scaffold.ctx.apiProxy.sessions.create({ rpcId: `create-${name}` as never,
    payload: { sessionId, cwd: scaffold.workspaceCwd } })
  if (!created.result.ok) throw new Error(`Synthetic Session creation failed: ${created.result.error.message}`)
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.attachSession(sessionId)
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  const target = page
  onTestFailed(() => saveFailureShot(target, `model-transport-${name}`))
  await target.addInitScript((id) => {
    if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
  }, sessionId)
  return { target, host: scaffold, sessionId, console: watchConsole(target) }
}

function owns(request: Request, sessionId: string): boolean {
  const body = request.postDataJSON() as { payload: { sessionId: string } }
  return body.payload.sessionId === sessionId
}

it.skipIf(MODE === 'record')('recovers a cold model label after one failed delivery without opening the picker', async () => {
  const { target, host, sessionId, console: tripwire } = await createWorld('cold-read')
  let reads = 0
  let selections = 0
  let failedAt = 0
  const firstFailure = Promise.withResolvers<undefined>()
  await target.route(/\/api\/session\.models(?:\?.*)?$/u, async (route) => {
    if (!owns(route.request(), sessionId)) { await route.continue(); return }
    reads += 1
    if (reads === 1) {
      failedAt = performance.now()
      await route.abort('failed')
      firstFailure.resolve(undefined)
      return
    }
    const response = await route.fetch()
    await route.fulfill({ response })
  })
  target.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/session.selectModel') && owns(request, sessionId)) selections += 1
  })
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  await firstFailure.promise
  const trigger = target.locator('[data-model-trigger]')
  await target.getByRole('button', { name: 'Select model, current Origin Large', exact: true }).waitFor()
  await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
  expect(await trigger.getAttribute('aria-expanded')).toBe('false')
  expect(await target.locator('textarea:enabled').count()).toBeGreaterThan(0)
  expect(reads).toBe(2)
  expect(selections).toBe(0)
  console.info('[model-transport-recovery]', JSON.stringify({ operation: 'cold-read', reads, selections,
    observedRecoveryAfterFailureMs: performance.now() - failedAt }))
  await mkdir(fileURLToPath(EXPECTED), { recursive: true })
  await compareOrRefreshGolden(fileURLToPath(new URL('cold-read.expected.md', EXPECTED)),
    await captureStableAria(target, '[data-model-select]', host.workspaceCwd), MODE)
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})

it.skipIf(MODE === 'record')('reports a failed selection delivery and permits a new explicit selection', async () => {
  const { target, host, sessionId, console: tripwire } = await createWorld('selection')
  let selections = 0
  const failed = Promise.withResolvers<undefined>()
  await target.route(/\/api\/session\.selectModel(?:\?.*)?$/u, async (route) => {
    if (!owns(route.request(), sessionId)) { await route.continue(); return }
    selections += 1
    if (selections === 1) {
      await route.abort('failed')
      failed.resolve(undefined)
      return
    }
    const response = await route.fetch()
    const body = await response.json() as { result: { ok: boolean } }
    expect(body.result.ok).toBe(true)
    await route.fulfill({ response })
  })
  await target.goto(host.authenticatedUrl, { waitUntil: 'load' })
  const trigger = target.getByRole('button', { name: 'Select model, current Origin Large', exact: true })
  await trigger.waitFor()
  await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
  await trigger.click()
  await target.getByRole('menuitem', { name: /^Model/u }).click()
  const choice = target.getByRole('menuitemradio', { name: /^Acme Large/u })
  await choice.click()
  await failed.promise
  const notice = target.getByRole('alert').filter({ hasText: 'Could not confirm the model change. Reload models to check the current selection.' })
  await notice.waitFor()
  await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
  expect(await choice.isEnabled()).toBe(true)
  expect(await trigger.textContent()).toContain('Origin Large')
  expect(selections).toBe(1)
  await mkdir(fileURLToPath(EXPECTED), { recursive: true })
  await compareOrRefreshGolden(fileURLToPath(new URL('selection-failure.expected.md', EXPECTED)),
    await captureStableAria(target, '[role="alert"]', host.workspaceCwd), MODE)
  expect(selections).toBe(1)
  await choice.click()
  const selected = target.getByRole('button', { name: 'Select model, current Acme Large', exact: true })
  await selected.waitFor()
  await expect.poll(() => selected.getAttribute('aria-busy')).toBe('false')
  await expect.poll(() => selected.getAttribute('aria-expanded')).toBe('false')
  expect(selections).toBe(2)
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})
