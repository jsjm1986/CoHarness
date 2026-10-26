/** Built Inspector entry, lazy panel and native Session storage through the real Web composition. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-experimental-inspector'
import type {} from '@deepseek-ai/dsh-client-modules'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const PROFILE = join(REPO_ROOT, 'packages/experimental/inspector-profile')
const EXPECTED = fileURLToPath(new URL('./expected/inspector-boot', import.meta.url))
const runFile = promisify(execFile)

it.skipIf(webSnapshotMode() === 'record')('boots inspection from separate transport groups with reusable shared application responses', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-inspector-transport-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    const failures: unknown[] = []
    await owned.browser?.close().catch((error: unknown) => failures.push(error))
    await owned.scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Inspector transport fixture cleanup failed')
  })
  const overlay = join(scratch, 'inspector.patch.yml')
  await writeFile(overlay, [
    '- id: experimental-inspector', '  disabled: true',
    '  config:', '    port: 0', '    captureFetch: false', '    clientOrigins: []',
    '- id: session-inspector', '  disabled: true', '',
  ].join('\n'))
  const inspected = await launchWebScaffold({
    workbench: true, openInApp: false,
    extraInstallAnchors: [join(PROFILE, 'package.json')],
    extraOverlayPath: [join(PROFILE, 'cordis.patch.yml'), overlay],
  })
  owned.scaffold = inspected
  const modules = inspected.ctx.get('clientModules')
  if (modules === undefined) throw new Error('Client module composition is missing')
  const diagnosticIds = new Set([
    '@deepseek-ai/dsh-experimental-inspector', '@deepseek-ai/dsh-experimental-session-inspector',
  ])
  const baseGraph = modules.graph()
  expect(baseGraph.entries.some(entry => diagnosticIds.has(entry.id))).toBe(false)
  const digest = (bytes: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
  const baseBatches = baseGraph.batches.filter(batch => batch.phase === 'application')
  const baseResponses = new Map<string, string>()
  for (const batch of baseBatches) {
    const response = await inspected.hostFetch(batch.url)
    expect(response.status).toBe(200)
    baseResponses.set(batch.url, digest(await response.arrayBuffer()))
  }
  const diagnostics = [...inspected.ctx.loader.entries()].filter(entry => diagnosticIds.has(entry.options.name))
  expect(new Set(diagnostics.map(entry => entry.options.name))).toEqual(diagnosticIds)
  for (const entry of diagnostics) await inspected.ctx.loader.update(entry.id, { disabled: false })
  await expect.poll(() => modules.graph().entries.filter(entry => diagnosticIds.has(entry.id)).length).toBe(2)
  const inspectedGraph = modules.graph()
  expect(inspectedGraph.entries.filter(entry => !diagnosticIds.has(entry.id))).toEqual(baseGraph.entries)
  const sharedBatches = inspectedGraph.batches.filter(batch => batch.phase === 'application'
    && !batch.entries.some(id => diagnosticIds.has(id)))
  expect(sharedBatches).toEqual(baseBatches)
  const diagnosticBatches = inspectedGraph.batches.filter(batch => batch.entries.some(id => diagnosticIds.has(id)))
  expect(diagnosticBatches).toHaveLength(1)
  expect(new Set(diagnosticBatches[0]!.entries)).toEqual(diagnosticIds)
  for (const batch of sharedBatches) {
    const second = await inspected.hostFetch(batch.url)
    expect(second.status).toBe(200)
    expect(second.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(digest(await second.arrayBuffer())).toBe(baseResponses.get(batch.url))
  }
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'inspector-shared-transport'))
  const tripwire = watchConsole(page)
  await page.goto(inspected.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, inspected.workspaceCwd)
  const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
  await composer.fill('Inspect this workspace without submitting a model task')
  expect(await composer.inputValue()).toBe('Inspect this workspace without submitting a model task')
  await expect.poll(() => page.locator('[data-inspector-panel]').count()).toBe(1)
  await compareOrRefreshGolden(join(EXPECTED, 'shared-transport-startup.expected.md'),
    await captureStableAria(page, 'body', inspected.workspaceCwd), webSnapshotMode())
  await page.keyboard.press('ControlOrMeta+Shift+.')
  await page.locator('[data-inspector-panel]').waitFor({ state: 'visible' })
  await page.frameLocator('[data-inspector-devtools]').getByRole('tab', { name: 'Console', exact: true }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  expect(await page.locator('[data-slot-error]').count()).toBe(0)
})

it.skipIf(webSnapshotMode() === 'record').each([
  { hostOnly: false, name: 'loopback Client' },
  { hostOnly: true, name: 'Host-only remote origin' },
])('boots the Inspector workbench and persists a locked Session for $name', async ({ hostOnly }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-inspector-boot-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  })
  const overlay = join(scratch, 'inspector.patch.yml')
  await writeFile(overlay, [
    '- id: experimental-inspector', '  config:', '    port: 0', '    captureFetch: false', '    clientOrigins: []',
    '- id: session-inspector', '  disabled: true', '',
  ].join('\n'))
  const world = await launchWebScaffold({
    workbench: true,
    openInApp: false,
    extraInstallAnchors: [join(PROFILE, 'package.json')],
    extraOverlayPath: [join(PROFILE, 'cordis.patch.yml'), overlay],
    // Chromium resolves *.localhost locally, but Inspector's exact origin policy does not admit it.
    ...(hostOnly ? { remoteAuthority: 'inspector-fixture.localhost' } : {}),
  })
  owned.scaffold = world
  const inspector = world.ctx.get('inspector')
  if (inspector === undefined) throw new Error('Inspector Host service did not activate')
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, `inspector-boot-${hostOnly ? 'host-only' : 'client'}`))
  const tripwire = watchConsole(page)
  const ingestSockets: string[] = []
  page.on('websocket', (socket) => { if (new URL(socket.url()).pathname === '/ingest') ingestSockets.push(socket.url()) })
  const described = page.waitForResponse(response => new URL(response.url()).pathname === '/api/host.describe')
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  const host = await described
  expect(host.status()).toBe(200)
  expect(await host.json()).toMatchObject({ result: { ok: true } })
  await page.getByRole('textbox', { name: 'Choose workspace' }).waitFor()
  await expect.poll(() => page.locator('[data-inspector-panel]').count()).toBe(1)
  await connectFreshWorkspace(page, world.workspaceCwd)
  const composer = page.locator('textarea:enabled[placeholder="Describe what you want to build"]')
  await composer.fill('Release boot check without a model submission')
  expect(await composer.inputValue()).toBe('Release boot check without a model submission')

  const id = SessionId('inspector-boot-storage')
  const created = await world.ctx.apiProxy.sessions.create({
    rpcId: RpcId('inspector-boot-create'), payload: { sessionId: id, cwd: world.workspaceCwd },
  })
  expect(created.result).toMatchObject({ ok: true, value: { sessionId: id } })
  const session = world.ctx.sessions.get(id)
  if (session === undefined) throw new Error('Created Session was not attached to the live store')
  expect(await world.ctx.sessions.flush(session)).toBe(true)
  const location = world.ctx.sessionPersistence.locate(session.header)
  if (location?.kind !== 'jsonl') throw new Error('Inspector boot did not use the shipped JSONL persistence')
  expect((await stat(location.path)).size).toBeGreaterThan(0)
  // POSIX uses the shipped native flock entry; Windows Session storage owns a kernel semaphore instead.
  if (process.platform !== 'win32') {
    const flockEntry = pathToFileURL(join(REPO_ROOT, 'native/system/packages/entry/lib/flock.js')).href
    const contender = [
      "import { open } from 'node:fs/promises'",
      `import { tryLockExclusive } from ${JSON.stringify(flockEntry)}`,
      "const handle = await open(process.argv[1], 'r+')",
      'try { await tryLockExclusive(handle.fd); process.exitCode = 2 }',
      "catch (error) { if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error; process.stdout.write(error.code) }",
      'finally { await handle.close() }',
    ].join('\n')
    const result = await runFile(process.execPath, ['--input-type=module', '-e', contender, join(dirname(location.path), 'session.lock')], {
      timeout: 30_000,
    })
    expect(result.stderr).toBe('')
    expect(result.stdout).toMatch(/^(EAGAIN|EWOULDBLOCK)$/u)
  }
  const connectedClients = async (): Promise<number> => (await inspector.cordis.getTree()).clients
    .filter(client => client.connection.state === 'connected').length
  await expect.poll(connectedClients).toBe(hostOnly ? 0 : 1)
  expect((await inspector.cordis.getTree()).host?.connection.state).toBe('connected')
  await page.keyboard.press('ControlOrMeta+Shift+.')
  const panel = page.locator('[data-inspector-panel]')
  await panel.waitFor({ state: 'visible' })
  const frame = panel.locator('iframe')
  await frame.waitFor()
  const source = await frame.getAttribute('src')
  if (source === null) throw new Error('Inspector panel did not specify its DevTools frontend')
  const selected = new URL(source, page.url()).searchParams
  expect(selected.get('sourceScope')).toBe(hostOnly ? 'host' : null)
  expect(selected.has('clientSourceId')).toBe(!hostOnly)
  await page.frameLocator('[data-inspector-devtools]').getByRole('tab', { name: 'Console', exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, `${hostOnly ? 'host-only' : 'client'}-panel.expected.md`),
    await captureStableAria(page, '[data-inspector-panel]', world.workspaceCwd), webSnapshotMode())
  await panel.getByRole('button', { name: 'Collapse', exact: true }).click()
  await panel.waitFor({ state: 'hidden' })
  expect(ingestSockets).toHaveLength(hostOnly ? 0 : 1)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  expect(await page.locator('[data-slot-error]').count()).toBe(0)
})
