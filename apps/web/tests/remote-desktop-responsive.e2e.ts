/** Real grants, consent, WebSocket transport and noVNC rendering against an isolated RFB peer. */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-remote-desktop'
import type {} from '@deepseek-ai/dsh-api-remote-desktop-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation, responsiveViewports, expectViewportFit } from './responsive-browser.ts'
import { startRfbFixture, type RfbFixture } from './rfb-fixture.ts'
import { saveFailureShot } from './support.ts'
import { auditWorkflowState, newWorkflowPage } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast, type TextContrastReading } from './text-contrast.ts'

const SESSION = SessionId('remote-desktop-responsive-root')
const MODES = ['control', 'view', 'password', 'recording'] as const
const SCENARIOS = [
  ...responsiveViewports.flatMap(viewport => MODES.map(mode => ({ ...viewport, mode, frameWidth: undefined as number | undefined }))),
  ...[600, 768, 1024].map(frameWidth => ({ name: `embedded-${frameWidth}`, width: 1280, height: 900, mode: 'control' as const, frameWidth })),
]

describe('web e2e: responsive remote desktop', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let desktop: RfbFixture
  let protectedDesktop: RfbFixture
  let directory: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-rfb-responsive-'))
    await mkdir(join(directory, 'recordings'))
    desktop = await startRfbFixture()
    protectedDesktop = await startRfbFixture(true)
    const overlay = join(directory, 'desktop.yml')
    const endpoints = MODES.map(mode => ({ nodeId: `screen-${mode}`, host: desktop.host,
      port: mode === 'password' ? protectedDesktop.port : desktop.port }))
    await writeFile(overlay, '- id: remote-desktop-vnc\n  config:\n    endpoints: ' + JSON.stringify(endpoints)
      + '\n    recordingDir: ' + JSON.stringify(join(directory, 'recordings')) + '\n    grantsFile: ":memory:"\n    auditFile: ":memory:"\n')
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const created = await scaffold.ctx.apiProxy.sessions.create({ rpcId: RpcId('desktop-create'), payload: { sessionId: SESSION, cwd: scaffold.workspaceCwd } })
    if (!created.result.ok) throw new Error(created.result.error.message)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(SESSION)
    for (const mode of MODES) {
      await scaffold.ctx.remoteDesktop.grant({ target: { nodeId: `screen-${mode}` }, principal: 'local-operator',
        level: mode === 'view' ? 'view' : 'control', scope: { kind: 'machine' }, recording: mode === 'recording', grantedBy: 'fixture' },
      { principal: 'local-operator', admin: true })
    }
    browser = await responsiveBrowser.launch()
  })
  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => { failures.push(error) })
    await scaffold?.close().catch((error: unknown) => { failures.push(error) })
    const peers = await Promise.allSettled([desktop?.close(), protectedDesktop?.close()])
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    for (const result of peers) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Remote desktop fixture cleanup failed')
  })

  it.each(SCENARIOS)('$name $mode connects, renders and keeps its controls reachable', async ({ name, width, height, mode, frameWidth }) => {
    const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation && width < 768, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    const peer = mode === 'password' ? protectedDesktop : desktop
    const before = peer.initialized
    const recordingsBefore = new Set(mode === 'recording' ? await readdir(join(directory, 'recordings')) : [])
    const recordingContrast: TextContrastReading[] = []
    const grant = await scaffold.ctx.remoteDesktop.grant({ target: { nodeId: `screen-${mode}` }, principal: 'local-operator',
      level: mode === 'view' ? 'view' : 'control', scope: { kind: 'machine' }, recording: mode === 'recording', grantedBy: 'viewport-fixture' },
    { principal: 'local-operator', admin: true })
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const appFrame = page.locator('[data-viewport]').first()
      if (frameWidth !== undefined) {
        await appFrame.evaluate((node: HTMLElement, size) => {
          node.style.width = `${size}px`
          node.style.marginInline = 'auto'
        }, frameWidth)
        await expect.poll(async () => (await appFrame.boundingBox())?.width).toBe(frameWidth)
      }
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      await page.locator('[data-sidebar-right-guide-entry="remoteDesktop"]').getByRole('button', { name: /^Connect to a remote desktop/ }).click()
      await page.getByRole('menuitem', { name: new RegExp(`screen-${mode}`) }).click()
      const confirm = page.getByRole('button', { name: 'Confirm and connect', exact: true })
      await confirm.waitFor()
      await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]').filter({ has: confirm }), [confirm])
      if (mode === 'recording') {
        recordingContrast.push(...await captureTextContrast(page, [{ label: 'consent-recording',
          text: page.getByText('This session will be recorded by an administrator.', { exact: true }) }],
        `remote-desktop-consent-${name}`))
      }
      await confirm.tap()
      if (mode === 'password') {
        const field = page.getByLabel('Password', { exact: true })
        await field.fill('fixture-password')
        const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
        await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]').filter({ has: signIn }), [field, signIn])
        expect((await field.boundingBox())?.height).toBeGreaterThanOrEqual(44)
        expect(await field.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16)
        await signIn.click()
      }
      await expect.poll(() => peer.initialized).toBeGreaterThan(before)
      const canvas = page.locator('[data-sidebar-right-panel] canvas').last()
      await canvas.waitFor()
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBe(640)
      await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
        const pixel = node.getContext('2d')?.getImageData(0, 0, 1, 1).data
        return pixel !== undefined && pixel[3] === 255 && pixel.slice(0, 3).some(channel => channel > 0)
      })).toBe(true)
      const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true })
      const quality = page.getByRole('button', { name: /^Quality:/ })
      const fit = page.getByRole('tab', { name: 'Fit', exact: true })
      const actual = page.getByRole('tab', { name: '1:1', exact: true })
      const surface = page.locator('div[data-sidebar-right-tab]').filter({ has: disconnect })
      await expectViewportFit(page, surface, [fit, actual, quality, disconnect])
      if (mode === 'recording') {
        recordingContrast.push(...await captureTextContrast(page, [
          { label: 'recording', text: surface.getByText('Recording', { exact: true }) },
        ], `remote-desktop-connected-${name}`))
      }
      await expect.poll(async () => {
        const frameBox = await appFrame.boundingBox()
        const panelBox = await page.locator('[data-sidebar-right-panel="fullscreen"]').boundingBox()
        if (frameBox === null || panelBox === null) return false
        return Math.abs(frameBox.x - panelBox.x) <= 1 && Math.abs(frameBox.width - panelBox.width) <= 1
          && Math.abs(frameBox.y - panelBox.y) <= 1 && Math.abs(frameBox.height - panelBox.height) <= 1
      }).toBe(true)
      await actual.click()
      expect(await actual.getAttribute('aria-selected')).toBe('true')
      await fit.click()
      await quality.click()
      await page.getByRole('menuitem', { name: 'Smooth', exact: true }).click()
      await page.getByRole('button', { name: 'Quality: Smooth', exact: true }).waitFor()
      const keys = page.getByRole('button', { name: 'Ctrl+Alt+Del', exact: true })
      if (mode === 'view') expect(await keys.count()).toBe(0)
      else {
        const inputCount = peer.inputs.length
        await canvas.tap()
        await expect.poll(() => peer.inputs.slice(inputCount).some(input => input.kind === 'pointer' && input.mask !== 0)).toBe(true)
        await expectViewportFit(page, surface, [keys])
        await keys.click()
        await expect.poll(() => peer.inputs.slice(inputCount).some(input => input.kind === 'key' && input.key === 0xffff)).toBe(true)
      }
      const screenshots = process.env.DSH_MOBILE_SCREENSHOTS
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: join(screenshots, `remote-desktop-${responsiveBrowserName}-${name}-${mode}.png`), animations: 'disabled' })
      }
      await disconnect.click()
      const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true })
      await reconnect.waitFor()
      await expectViewportFit(page, page.locator('div[data-sidebar-right-tab]').filter({ has: reconnect }), [reconnect])
      const connected = peer.initialized
      await reconnect.tap()
      if (mode === 'password') {
        await page.getByLabel('Password', { exact: true }).fill('fixture-password')
        await page.getByRole('button', { name: 'Sign in', exact: true }).tap()
      }
      await expect.poll(() => peer.initialized).toBeGreaterThan(connected)
      await page.getByRole('button', { name: 'Quality: Smooth', exact: true }).waitFor()
      expect(await fit.getAttribute('aria-selected')).toBe('true')
      await disconnect.tap()
      await reconnect.waitFor()
      await expect.poll(async () => (await scaffold.ctx.remoteDesktop.status(
        { principal: 'local-operator', admin: true }, { nodeId: `screen-${mode}` }, { sessionId: SESSION },
      )).attachments).toBe(0)
      if (mode === 'recording') {
        await expect.poll(async () => {
          const files = (await readdir(join(directory, 'recordings'))).filter(file => !recordingsBefore.has(file))
          const sizes = await Promise.all(files.map(file => stat(join(directory, 'recordings', file))))
          return sizes.some(file => file.size > 0)
        }).toBe(true)
      }
      expect(peer.errors).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
      if (mode === 'recording') expectTextContrast(recordingContrast)
    } catch (error) {
      await saveFailureShot(page, `remote-desktop-${responsiveBrowserName}-${name}-${mode}`)
      throw error
    } finally {
      try { await page.close() }
      finally { await scaffold.ctx.remoteDesktop.revoke(grant.id, { principal: 'local-operator', admin: true }) }
    }
  })

  it('keeps separate target streams alive across tab changes and releases only the closed target', async () => {
    const page = await browser.newPage({ viewport: { width: 1680, height: 900 }, locale: 'en-US', hasTouch: true,
      isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' })
    const tripwire = watchConsole(page)
    const actor = { principal: 'local-operator', admin: true }
    const targets = ['control', 'view'] as const
    const grants = await Promise.all(targets.map(mode => scaffold.ctx.remoteDesktop.grant({
      target: { nodeId: `screen-${mode}` }, principal: actor.principal,
      level: mode, scope: { kind: 'machine' }, recording: false, grantedBy: 'target-switch-fixture',
    }, actor)))
    const attachmentCount = async (mode: typeof targets[number]) => (await scaffold.ctx.remoteDesktop.status(
      actor, { nodeId: `screen-${mode}` }, { sessionId: SESSION },
    )).attachments
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      for (const mode of targets) {
        if (mode === 'view') await page.getByRole('button', { name: 'New tab', exact: true }).tap()
        await page.locator('[data-sidebar-right-guide-entry="remoteDesktop"]')
          .getByRole('button', { name: /^Connect to a remote desktop/ }).tap()
        await page.getByRole('menuitem', { name: new RegExp(`screen-${mode}`) }).tap()
        await page.getByRole('button', { name: 'Confirm and connect', exact: true }).tap()
        await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor()
        await expect.poll(() => page.locator('[data-sidebar-right-panel] canvas:visible')
          .evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(640)
        await expect.poll(() => attachmentCount(mode)).toBe(1)
      }
      const connected = desktop.initialized
      const tabs = page.locator('[data-sidebar-right-panel] [data-dockkit-tab]')
      expect(await tabs.count()).toBe(2)
      expect(await tabs.nth(0).innerText()).toContain('screen-control')
      expect(await tabs.nth(1).innerText()).toContain('screen-view')
      for (const [index, mode] of targets.entries()) {
        await tabs.nth(index).tap()
        const body = page.locator('div[data-sidebar-right-tab]:visible')
          .filter({ has: page.getByRole('button', { name: 'Disconnect', exact: true }) })
        await auditWorkflowState(page, 'remote-desktop', `retained-${mode}-target`, body, [tabs.nth(index)], async () => {
          await tabs.nth(1 - index).tap()
          await tabs.nth(index).tap()
          expect(await tabs.nth(index).getAttribute('aria-selected')).toBe('true')
          expect(await page.getByRole('button', { name: 'Ctrl+Alt+Del', exact: true }).count()).toBe(mode === 'control' ? 1 : 0)
          expect(desktop.initialized).toBe(connected)
          expect(await attachmentCount('control')).toBe(1)
          expect(await attachmentCount('view')).toBe(1)
        })
      }
      await tabs.nth(0).tap()
      await tabs.nth(0).getByRole('button', { name: 'Close', exact: true }).tap()
      await expect.poll(() => attachmentCount('control')).toBe(0)
      expect(await attachmentCount('view')).toBe(1)
      expect(await tabs.count()).toBe(1)
      await tabs.nth(0).getByRole('button', { name: 'Close', exact: true }).tap()
      await expect.poll(() => attachmentCount('view')).toBe(0)
      expect(desktop.initialized).toBe(connected)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `remote-desktop-${responsiveBrowserName}-target-switch`)
      throw error
    } finally {
      try { await page.close() }
      finally { for (const grant of grants) await scaffold.ctx.remoteDesktop.revoke(grant.id, actor) }
    }
  })
})

describe('web e2e: remote desktop access and recovery states', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let peer: RfbFixture
  let peerClosed = false
  let directory: string
  const target = { nodeId: 'screen-recovery' }
  const actor = { principal: 'local-operator', admin: true }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-rfb-states-'))
    peer = await startRfbFixture()
    const overlay = join(directory, 'desktop.yml')
    await writeFile(overlay, '- id: remote-desktop-vnc\n  config:\n    endpoints: '
      + JSON.stringify([{ ...target, host: peer.host, port: peer.port }]) + '\n    grantsFile: ":memory:"\n    auditFile: ":memory:"\n')
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const created = await scaffold.ctx.apiProxy.sessions.create({ rpcId: RpcId('desktop-states-create'),
      payload: { sessionId: SESSION, cwd: scaffold.workspaceCwd } })
    if (!created.result.ok) throw new Error(created.result.error.message)
    await (await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)).attachSession(SESSION)
    browser = await responsiveBrowser.launch()
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        try { if (peer !== undefined && !peerClosed) await peer.close() }
        finally { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) }
      }
    }
  })

  it('shows grant discovery, consent races, provider failures and unavailable endpoint recovery', async () => {
    const page = await newWorkflowPage(browser, 900)
    const tripwire = watchConsole(page)
    const list = scaffold.ctx.remoteDesktop.listGrants.bind(scaffold.ctx.remoteDesktop)
    const status = scaffold.ctx.remoteDesktop.status.bind(scaffold.ctx.remoteDesktop)
    const attach = scaffold.ctx.remoteDesktop.attach.bind(scaffold.ctx.remoteDesktop)
    const listSpy = vi.spyOn(scaffold.ctx.remoteDesktop, 'listGrants')
    const statusSpy = vi.spyOn(scaffold.ctx.remoteDesktop, 'status')
    const attachSpy = vi.spyOn(scaffold.ctx.remoteDesktop, 'attach')
    const listed = Promise.withResolvers<undefined>()
    const probed = Promise.withResolvers<undefined>()
    const attaching = Promise.withResolvers<undefined>()
    const issueGrant = () => scaffold.ctx.remoteDesktop.grant({ target, principal: actor.principal,
      level: 'control', scope: { kind: 'machine' }, recording: false, grantedBy: 'recovery-fixture' }, actor)
    try {
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click()
      const picker = page.locator('[data-sidebar-right-guide-entry="remoteDesktop"]')
        .getByRole('button', { name: /^Connect to a remote desktop/ })
      const menu = page.getByRole('menu')
      const auditFeedback = async (state: string, text: string) => {
        const feedback = menu.getByText(text, { exact: true })
        await feedback.waitFor()
        expect(await menu.getByRole('menuitem', { name: text, exact: true }).count()).toBe(0)
        await auditWorkflowState(page, 'remote-desktop', state, menu, [feedback], async () => {
          expect(await feedback.evaluate((node) => {
            const element = node as HTMLElement
            return { wraps: getComputedStyle(element).whiteSpace === 'normal',
              clipped: Math.max(element.scrollHeight - element.clientHeight, element.scrollWidth - element.clientWidth) }
          })).toEqual({ wraps: true, clipped: 0 })
        })
      }
      listSpy.mockImplementationOnce(async (...args) => { await listed.promise; return list(...args) })
      await picker.click()
      await auditFeedback('targets-loading', 'Reading your authorized targets…')
      listed.resolve(undefined)
      await auditFeedback('targets-empty', 'No targets available; ask an administrator.')
      await page.keyboard.press('Escape')

      listSpy.mockRejectedValueOnce(new Error('Grant catalog is temporarily unavailable'))
      await picker.click()
      await auditFeedback('targets-failed', 'Could not read your authorized targets; retry later.')
      expect(await menu.getByRole('status').innerText()).toBe('Could not read your authorized targets; retry later.')
      await menu.getByRole('menuitem', { name: 'Retry', exact: true }).click()
      await menu.getByText('No targets available; ask an administrator.', { exact: true }).waitFor()
      await page.keyboard.press('Escape')

      const firstGrant = await issueGrant()
      statusSpy.mockImplementationOnce(async (...args) => { await probed.promise; return status(...args) })
      await picker.click()
      await menu.getByRole('menuitem', { name: /screen-recovery/ }).click()
      const surface = page.locator('div[data-sidebar-right-tab]').filter({ hasText: 'Reading desktop status…' })
      await surface.waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'status-loading', surface)
      probed.resolve(undefined)
      const confirm = page.getByRole('button', { name: 'Confirm and connect', exact: true })
      await confirm.waitFor()
      await scaffold.ctx.remoteDesktop.revoke(firstGrant.id, actor)
      await confirm.click()
      const body = page.locator('div[data-sidebar-right-tab]').filter({ has: page.getByRole('button', { name: 'Retry', exact: true }) })
      const retry = body.getByRole('button', { name: 'Retry', exact: true })
      await body.getByText('You have no access grant for this remote desktop; ask an administrator.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'grant-revoked-before-consent', body, [retry])

      statusSpy.mockRejectedValueOnce(new RemoteError('remote-desktop/failure', 'Removed target', { code: 'REMOTE_DESKTOP_STALE_TARGET' }))
      await retry.click()
      await body.getByText('This desktop target is stale; refresh and try again.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'stale-target', body, [retry])
      statusSpy.mockRejectedValueOnce(new Error('The desktop provider could not read its endpoint configuration.'))
      await retry.click()
      await body.getByText(/Remote desktop failed:/).waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'status-failed', body, [retry])

      await issueGrant()
      await retry.click()
      await confirm.waitFor()
      const consent = page.locator('div[data-sidebar-right-tab]').filter({ has: confirm })
      await auditWorkflowState(page, 'remote-desktop', 'grant-reissued-consent', consent, [confirm])
      attachSpy.mockImplementationOnce(async (...args) => {
        await attaching.promise
        // A new real grant invalidates consent between confirm and attach.
        await issueGrant()
        return attach(...args)
      })
      await confirm.click()
      const pending = page.getByText('Establishing the connection…', { exact: true })
      await pending.waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'attaching', page.locator('div[data-sidebar-right-tab]').filter({ has: pending }))
      attaching.resolve(undefined)
      await confirm.waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'grants-changed-confirm-again', consent, [confirm])
      await confirm.click()
      await expect.poll(() => peer.initialized).toBe(1)
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor()
      await peer.close()
      peerClosed = true
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      await body.getByText(/^This desktop cannot be connected now\./).waitFor()
      await auditWorkflowState(page, 'remote-desktop', 'endpoint-unavailable', body, [retry])
      const attempts = statusSpy.mock.calls.length
      await retry.click()
      await expect.poll(() => statusSpy.mock.calls.length).toBe(attempts + 1)
      await body.getByText(/^This desktop cannot be connected now\./).waitFor()
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, `remote-desktop-${responsiveBrowserName}-recovery`)
      throw error
    } finally {
      listed.resolve(undefined); probed.resolve(undefined); attaching.resolve(undefined)
      listSpy.mockRestore(); statusSpy.mockRestore(); attachSpy.mockRestore()
      await page.close()
    }
  }, 180_000)
})
