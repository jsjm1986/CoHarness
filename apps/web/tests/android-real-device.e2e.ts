/** Opt-in acceptance on an explicitly selected Android device, using disposable application data. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { connectAdminAndroid, adminAndroidEndpoint } from './admin-android-browser.ts'
import { launchWebScaffold, seedSession } from './scaffold.ts'
import { pdfFixture } from '../../../packages/client/ui-workbench/tests/pdf-fixture.ts'

const run = promisify(execFile)

/** Real transcript content supplies independent vertical and horizontal touch scroll owners. */
function gestureHistory(): string {
  const session = Session.create(SessionId('android-gesture-source'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: [
      ...Array.from({ length: 24 }, (_, index) => `Reading paragraph ${index + 1}. Vertical scrolling stays with the conversation while the navigation drawer is closed.`),
      '```text\n' + Array.from({ length: 6 }, (_, index) => `native_horizontal_${index + 1}: ${'0123456789 '.repeat(24)}`).join('\n') + '\n```',
    ].join('\n\n') }], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

it.skipIf(adminAndroidEndpoint === undefined)('Android hardware keeps settings, selected plugin flows and an edited draft reachable with the real keyboard and rotation', async ({ task }) => {
  const serial = process.env.DSH_ANDROID_SERIAL
  if (!serial) throw new Error('DSH_ANDROID_SERIAL must identify the test phone')
  const adb = async (...args: string[]): Promise<string> => (await run('adb', ['-s', serial, ...args])).stdout.trim()
  const setSystem = async (key: 'user_rotation' | 'accelerometer_rotation', value: string): Promise<void> => {
    if (!/^[0-3]$/.test(value)) throw new Error(`Unexpected Android rotation setting: ${value}`)
    if (process.env.DSH_ANDROID_ROOT === '1') await adb('shell', `su -c 'settings put system ${key} ${value}'`)
    else await adb('shell', 'settings', 'put', 'system', key, value)
  }
  const pressBack = async (): Promise<void> => {
    if (process.env.DSH_ANDROID_ROOT === '1') await adb('shell', "su -c 'input keyevent 4'")
    else await adb('shell', 'input', 'keyevent', '4')
  }
  const rotation = await adb('shell', 'settings', 'get', 'system', 'user_rotation')
  const automatic = await adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation')
  const systemMatrix = process.env.DSH_ANDROID_SYSTEM_MATRIX === '1'
  const originalDensity = (await adb('shell', 'wm', 'density')).match(/Override density: (\d+)/)?.[1] ?? 'reset'
  const physicalWidth = Number((await adb('shell', 'wm', 'size')).match(/Physical size: (\d+)x/)?.[1])
  if (!Number.isFinite(physicalWidth)) throw new Error('Android did not report a physical screen width')
  const originalFont = await adb('shell', 'settings', 'get', 'system', 'font_scale')
  const originalIme = await adb('shell', 'settings', 'get', 'secure', 'default_input_method')
  const testIme = process.env.DSH_ANDROID_IME
  const imePattern = /^[a-zA-Z0-9._]+\/[a-zA-Z0-9._]+$/
  const densityPattern = /^(reset|[1-9]\d*)$/
  const fontPattern = /^\d+(?:\.\d+)?$/
  if (!/^[0-3]$/.test(rotation) || !/^[01]$/.test(automatic)
    || (systemMatrix && (!densityPattern.test(originalDensity) || !fontPattern.test(originalFont)))
    || (testIme !== undefined && (!imePattern.test(originalIme) || !imePattern.test(testIme)))) {
    throw new Error('Android acceptance requires readable, restorable rotation, display and input method settings before changing the device')
  }
  async function selectIme(value: string): Promise<void> {
    if (!imePattern.test(value)) throw new Error('Invalid input method component')
    await adb('shell', `su -c 'ime set ${value}'`)
  }
  async function density(value: string): Promise<void> {
    if (!densityPattern.test(value)) throw new Error(`Invalid Android density: ${value}`)
    await adb('shell', `su -c 'wm density ${value}'`)
  }
  async function font(value: string): Promise<void> {
    if (!fontPattern.test(value)) throw new Error(`Invalid Android font scale: ${value}`)
    await adb('shell', `su -c 'settings put system font_scale ${value}'`)
  }
  if ((systemMatrix || testIme || process.env.DSH_ANDROID_OCCLUDING_IME === '1') && process.env.DSH_ANDROID_ROOT !== '1') {
    throw new Error('System settings and input method scenarios require an explicitly authorized rooted test phone')
  }
  const featurePages = process.env.DSH_ANDROID_FEATURE_PAGES === '1'
  const documentPages = process.env.DSH_ANDROID_DOCUMENTS === '1'
  const workbenchPages = process.env.DSH_ANDROID_WORKBENCH === '1'
  const world = await launchWebScaffold({
    remoteAuthority: `dsh-android-${randomUUID().slice(0, 8)}.localhost`,
    workbench: documentPages || workbenchPages,
    ...(featurePages ? { extraOverlayPath: fileURLToPath(new URL('./user-terminal-typing.overlay.yml', import.meta.url)) } : {}),
  })
  const owned: {
    connection?: Awaited<ReturnType<typeof connectAdminAndroid>>
    page?: Page
    preview?: Server
    previewSocket?: string
  } = {}
  onTestFinished(async () => {
    const restoreErrors: unknown[] = []
    const restore = async (action: () => Promise<void>): Promise<void> => {
      try { await action() } catch (error) { restoreErrors.push(error) }
    }
    const restoreSettings = async (): Promise<void> => {
      if (systemMatrix) {
        await restore(() => density(originalDensity))
        await restore(() => font(originalFont))
      }
      if (testIme) await restore(() => selectIme(originalIme))
      await restore(() => setSystem('user_rotation', rotation))
      await restore(() => setSystem('accelerometer_rotation', automatic))
      await restore(async () => {
        await expect.poll(() => adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation')).toBe(automatic)
        await expect.poll(() => adb('shell', 'settings', 'get', 'system', 'user_rotation')).toBe(rotation)
        if (testIme) await expect.poll(() => adb('shell', 'settings', 'get', 'secure', 'default_input_method')).toBe(originalIme)
        if (systemMatrix) {
          await expect.poll(() => adb('shell', 'settings', 'get', 'system', 'font_scale')).toBe(originalFont)
          await expect.poll(async () => (await adb('shell', 'wm', 'density')).match(/Override density: (\d+)/)?.[1] ?? 'reset').toBe(originalDensity)
        }
        if (process.env.DSH_ANDROID_ARTIFACTS) {
          await mkdir(process.env.DSH_ANDROID_ARTIFACTS, { recursive: true })
          await writeFile(join(process.env.DSH_ANDROID_ARTIFACTS, 'settings-restoration.json'), JSON.stringify({
            serial, automatic, rotation, ...(testIme ? { inputMethod: originalIme } : {}),
            ...(systemMatrix ? { density: originalDensity, fontScale: originalFont } : {}), verified: true,
          }, null, 2) + '\n')
        }
      })
      if (restoreErrors.length > 0) throw new AggregateError(restoreErrors, 'Android settings restoration failed')
    }
    try {
      if (task.result?.state === 'fail' && process.env.DSH_ANDROID_ARTIFACTS && owned.page && !owned.page.isClosed()) {
        const directory = process.env.DSH_ANDROID_ARTIFACTS
        await restore(async () => {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'failed-page.aria.md'), await owned.page!.locator('body').ariaSnapshot() + '\n')
          const geometry = await owned.page!.evaluate(() => {
            const measure = (element: Element) => {
              const { x, y, width, height, top, bottom, left, right } = element.getBoundingClientRect()
              return { x, y, width, height, top, bottom, left, right }
            }
            return {
              width: innerWidth, height: innerHeight,
              viewport: { top: visualViewport!.offsetTop, height: visualViewport!.height, width: visualViewport!.width },
              controls: [...document.querySelectorAll('input,textarea,select,iframe')].map(element => ({
                tag: element.tagName, name: element.getAttribute('aria-label'), rect: measure(element),
                ancestors: (() => {
                  const nodes = []
                  for (let node = element.parentElement; node && nodes.length < 20; node = node.parentElement) {
                    nodes.push({ className: node.className, rect: measure(node),
                      overflow: getComputedStyle(node).overflowY, scrollHeight: node.scrollHeight,
                      clientHeight: node.clientHeight, scrollTop: node.scrollTop })
                  }
                  return nodes
                })(),
              })),
            }
          })
          await writeFile(join(directory, 'failed-geometry.json'), JSON.stringify(geometry, null, 2) + '\n')
          const capture = await run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
            encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
          })
          await writeFile(join(directory, 'failed-device.png'), capture.stdout)
          await owned.page!.screenshot({ path: join(directory, 'failed-page.png') })
        })
      }
    } finally {
      try { await owned.page?.close() } finally {
        try { await owned.connection?.close() } finally {
          try {
            if (owned.previewSocket) await adb('reverse', '--remove', owned.previewSocket)
          } finally {
            try {
              if (owned.preview?.listening) {
                const closed = new Promise<void>((resolve, reject) => {
                  owned.preview!.close((error) => { if (error) reject(error); else resolve() })
                })
                owned.preview.closeAllConnections()
                await closed
              }
            } finally {
              try { await world.close() } finally { await restoreSettings() }
            }
          }
        }
      }
    }
  })
  if (testIme) await selectIme(testIme)
  const id = SessionId('android-physical-acceptance')
  const created = await world.ctx.apiProxy.sessions.create({ rpcId: RpcId('android-create'), payload: { sessionId: id, cwd: world.workspaceCwd } })
  if (!created.result.ok) throw new Error(created.result.error.message)
  await (await world.ctx.workspaceRegistry.create(world.workspaceCwd)).attachSession(id)
  const gestureId = await seedSession(world, gestureHistory(), 'android-gesture-acceptance')
  await (await world.ctx.workspaceRegistry.create(world.workspaceCwd)).attachSession(gestureId)
  const connected = await connectAdminAndroid(world.authenticatedUrl)
  owned.connection = connected
  const context = connected.browser.contexts()[0]
  if (!context) throw new Error('Android browser has no native context')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(world.baseUrl).origin })
  const page = await context.newPage()
  owned.page = page
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'en-US' })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'] })
  })
  async function reach(control: Locator): Promise<{ x: number; y: number }> {
    await control.waitFor()
    let lastState: unknown
    for (let attempt = 0; attempt < 24; attempt++) {
      await control.evaluate(element => new Promise<void>((resolve) => {
        let previous = '', stableSince = performance.now()
        const settle = (now: number) => {
          const rect = element.getBoundingClientRect(), viewport = visualViewport!
          const current = [rect.x, rect.y, rect.width, rect.height, viewport.height, viewport.offsetTop].join(',')
          if (current !== previous) { previous = current; stableSince = now }
          if (now - stableSince >= 250) resolve()
          else requestAnimationFrame(settle)
        }
        requestAnimationFrame(settle)
      }))
      const state = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect(), viewport = visualViewport!
        let left = viewport.offsetLeft, right = left + viewport.width
        let top = viewport.offsetTop, bottom = top + viewport.height
        const scrollports: Array<{ node: HTMLElement; horizontal: boolean; vertical: boolean }> = []
        for (let node = element.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node), bounds = node.getBoundingClientRect()
          if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
            left = Math.max(left, bounds.left); right = Math.min(right, bounds.right)
          }
          if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
            top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom)
          }
          const horizontal = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
          const vertical = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
          if (horizontal || vertical) scrollports.push({ node, horizontal, vertical })
          if (node.matches(':modal, :popover-open')) break
        }
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        const fits = rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= top - 1 && rect.bottom <= bottom + 1
        let gesture: { x: number; y: number; xDistance?: number; yDistance?: number } | null = null
        const direction = rect.bottom > bottom + 1 ? -1 : rect.top < top - 1 ? 1 : 0
        const horizontalDirection = rect.right > right + 1 ? -1 : rect.left < left - 1 ? 1 : 0
        for (const [index, { node: owner, horizontal, vertical }] of scrollports.entries()) {
          const bounds = owner.getBoundingClientRect()
          let ownerLeft = Math.max(viewport.offsetLeft, bounds.left)
          let ownerRight = Math.min(viewport.offsetLeft + viewport.width, bounds.right)
          let ownerTop = Math.max(viewport.offsetTop, bounds.top)
          let ownerBottom = Math.min(viewport.offsetTop + viewport.height, bounds.bottom)
          for (let parent = owner.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect()
            if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
              ownerLeft = Math.max(ownerLeft, bounds.left); ownerRight = Math.min(ownerRight, bounds.right)
            }
            if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
              ownerTop = Math.max(ownerTop, bounds.top); ownerBottom = Math.min(ownerBottom, bounds.bottom)
            }
            if (parent.matches(':modal, :popover-open')) break
          }
          if (horizontal && horizontalDirection !== 0 && ownerRight - ownerLeft >= 24) {
            const canScroll = horizontalDirection < 0 ? owner.scrollLeft + owner.clientWidth < owner.scrollWidth - 1 : owner.scrollLeft > 0
            if (canScroll) {
              const padding = rect.width >= ownerRight - ownerLeft - 32 ? 0 : 16
              const gap = horizontalDirection < 0 ? rect.right - ownerRight + padding : ownerLeft - rect.left + padding
              const distance = Math.min((ownerRight - ownerLeft) * 0.6, gap)
              gesture = { x: ownerLeft + (ownerRight - ownerLeft) * (horizontalDirection < 0 ? 0.8 : 0.2), y: (ownerTop + ownerBottom) / 2,
                xDistance: horizontalDirection * distance }
              break
            }
          }
          // Expose a clipped inner scrollport before trying to reach its content.
          // A sticky composer can lie above the viewport while its owning scrollport is still below it.
          const inner = scrollports[index - 1]?.node.getBoundingClientRect()
          const innerBlocked = inner !== undefined && Math.min(ownerBottom, inner.bottom) - Math.max(ownerTop, inner.top)
            < Math.min(rect.height, inner.height, ownerBottom - ownerTop) - 1
          const verticalDirection = innerBlocked ? (inner.top > ownerTop ? -1 : 1) : direction
          const canScroll = verticalDirection < 0 ? owner.scrollTop + owner.clientHeight < owner.scrollHeight - 1 : owner.scrollTop > 0
          if (!vertical || !canScroll || verticalDirection === 0
            || ownerBottom - ownerTop < Math.min(rect.height, bounds.height) - 1
            || ownerBottom - ownerTop < 24) continue
          const padding = rect.height >= ownerBottom - ownerTop - 32 ? 0 : 16
          const gap = innerBlocked ? (verticalDirection < 0 ? inner.top - ownerTop : ownerBottom - inner.bottom)
            : verticalDirection < 0 ? rect.bottom - ownerBottom + padding : ownerTop - rect.top + padding
          const distance = Math.min((ownerBottom - ownerTop) * 0.6, gap)
          gesture = { x: ownerRight - 4, y: ownerTop + (ownerBottom - ownerTop) * (verticalDirection < 0 ? 0.8 : 0.2),
            yDistance: verticalDirection * distance }
          break
        }
        return { fits, hit: target !== null && element.contains(target), gesture,
          name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          layoutHeight: innerHeight, frameHeight: document.querySelector('[data-viewport]')?.getBoundingClientRect().height,
          publishedHeight: getComputedStyle(document.documentElement).getPropertyValue('--dsw-viewport-height'),
          viewport: { top: viewport.offsetTop, height: viewport.height }, clip: { left, right, top, bottom } }
      })
      const box = await control.boundingBox()
      lastState = state
      if (!box) throw new Error('Native touch target has no visible bounds')
      if (state.fits && state.hit) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      if (state.gesture === null) throw new Error(`Native touch target is unreachable: ${JSON.stringify(state)}`)
      await cdp.send('Input.synthesizeScrollGesture', {
        ...state.gesture, x: state.gesture.x + box.x - state.rect.x, y: state.gesture.y + box.y - state.rect.y,
        gestureSourceType: 'touch', preventFling: true, speed: 500,
      })
    }
    throw new Error(`Native touch target stayed unreachable after scrolling its visible container: ${JSON.stringify(lastState)}`)
  }
  async function tap(control: Locator): Promise<void> {
    const point = await reach(control)
    expect(await control.isEnabled(), 'Native touch target must be enabled').toBe(true)
    await cdp.send('Input.synthesizeTapGesture', { ...point, gestureSourceType: 'touch', duration: 60 })
  }
  const failures: string[] = []
  page.on('pageerror', error => failures.push(error.message))
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  await page.bringToFront()
  await page.locator('[data-viewport]').waitFor()
  const output = process.env.DSH_ANDROID_ARTIFACTS
  if (output) await mkdir(output, { recursive: true })
  const receipts: unknown[] = []

  async function expectVisibleControl(control: Locator): Promise<void> {
    await expect.poll(() => control.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const viewport = visualViewport!
      let left = viewport.offsetLeft, right = left + viewport.width
      let top = viewport.offsetTop, bottom = top + viewport.height
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        const rect = ancestor.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right) }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom) }
      }
      return box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1
    })).toBe(true)
  }

  async function fit(name: string, controls: readonly Locator[] = [], keyboardVisible = false): Promise<void> {
    await page.evaluate(async () => {
      await Promise.allSettled(document.getAnimations()
        .filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished))
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() })))
    })
    for (const control of controls) {
      await reach(control)
      await expectVisibleControl(control)
    }
    const metrics = await page.evaluate(() => ({
      width: innerWidth, height: innerHeight, viewportHeight: visualViewport?.height,
      scrollWidth: document.documentElement.scrollWidth, dpr: devicePixelRatio,
      coarse: matchMedia('(pointer: coarse)').matches,
      screen: { width: screen.width, height: screen.height },
      textSize: getComputedStyle(document.body).fontSize,
      visualViewportTop: visualViewport?.offsetTop,
      visualViewportScale: visualViewport?.scale,
    }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1)
    if (keyboardVisible) expect(metrics.height - metrics.viewportHeight!, `${name}: native keyboard remains open`).toBeGreaterThan(80)
    receipts.push({ name, ...metrics })
    if (output) {
      if (name.startsWith('workbench-')) {
        const layout = await page.locator('[data-session-pane] textarea').evaluateAll(elements => elements.map((element) => {
          const measure = (node: Element) => {
            const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
            return { tag: node.tagName, className: node.className,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              overflowY: style.overflowY, position: style.position,
              scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
              composerFlow: node.hasAttribute('data-composer-flow') }
          }
          const ancestors = []
          for (let node = element.parentElement; node; node = node.parentElement) {
            ancestors.push(measure(node))
            if (node.hasAttribute('data-session-pane')) break
          }
          return { control: measure(element), ancestors }
        }))
        await writeFile(join(output, name + '.layout.json'), JSON.stringify({ metrics, layout }, null, 2) + '\n')
      }
      const capture = await run('adb', ['-s', serial!, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
      await writeFile(join(output, name + '.png'), capture.stdout)
      if (metrics.height - metrics.viewportHeight! > 80) {
        // Native screen capture retains the IME; page capture can repaint a different layout viewport.
        const afterNativeCapture = await page.evaluate(() => ({ height: innerHeight, visibleHeight: visualViewport!.height,
          focused: document.hasFocus(), activeTag: document.activeElement?.tagName }))
        if (keyboardVisible) expect(afterNativeCapture.height - afterNativeCapture.visibleHeight).toBeGreaterThan(80)
        await writeFile(join(output, name + '.capture-state.json'),
          JSON.stringify({ before: metrics, afterNativeCapture, pageCapture: 'omitted while native IME is visible' }, null, 2) + '\n')
      } else await page.screenshot({ path: join(output, name + '.page.png') })
      await writeFile(join(output, 'user-device-receipts.json'), JSON.stringify(receipts, null, 2) + '\n')
    }
  }
  async function openDrawer(target: Page): Promise<void> {
    const trigger = target.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await trigger.isVisible()) await tap(trigger)
  }
  async function settleVisibleViewport(): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
      let height = visualViewport!.height, stableSince = performance.now()
      const settle = (now: number) => {
        if (visualViewport!.height !== height) { height = visualViewport!.height; stableSince = now }
        if (now - stableSince >= 200) resolve()
        else requestAnimationFrame(settle)
      }
      requestAnimationFrame(settle)
    }))
  }
  async function hideKeyboard(): Promise<void> {
    const shown = async (): Promise<boolean> => (await adb('shell', 'dumpsys', 'input_method')).includes('mInputShown=true')
    // Android's editing action menu consumes Back before the keyboard does.
    for (let attempt = 0; attempt < 3 && await shown(); attempt++) {
      await pressBack()
      await settleVisibleViewport()
    }
    expect(await shown(), 'Native keyboard closed after dismissing any editing menu').toBe(false)
    await expect.poll(() => page.evaluate(() => innerHeight - visualViewport!.height)).toBeLessThan(80)
    await settleVisibleViewport()
  }
  async function rotate(value: '0' | '1'): Promise<void> {
    await setSystem('accelerometer_rotation', '0')
    await setSystem('user_rotation', value)
    await expect.poll(() => page.evaluate(() => screen.width > screen.height), { timeout: 15_000 }).toBe(value === '1')
  }
  async function selectFixtureSession(sessionId: SessionId): Promise<void> {
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('dsh.sessions.current', ${JSON.stringify(JSON.stringify({ sessionId }))})`,
    })
    try { await page.reload({ waitUntil: 'load' }) }
    finally { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }) }
  }
  await rotate('0')
  await selectFixtureSession(gestureId)
  const frame = page.locator('[data-viewport="compact"]')
  const drawerToggle = frame.getByRole('button', { name: /^(Open|Close) sidebar$/ })
  await frame.waitFor()
  if (await drawerToggle.getAttribute('aria-expanded') === 'true') await tap(drawerToggle)
  await expect.poll(() => drawerToggle.getAttribute('aria-expanded')).toBe('false')
  const transcript = page.locator('[data-conversation-scroll]').filter({ has: page.locator('.md-code-block') })
  const code = transcript.locator('.md-code-block')
  const wrap = code.getByRole('button', { name: 'Wrap lines', exact: true })
  await hideKeyboard()
  await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('true')
  await tap(wrap)
  await expect.poll(() => wrap.getAttribute('aria-pressed')).toBe('false')
  const source = code.locator('pre')
  const sourcePoint = await reach(source)
  const horizontalBefore = await source.evaluate(element => ({
    left: element.scrollLeft, overflow: element.scrollWidth - element.clientWidth,
  }))
  expect(horizontalBefore.overflow, 'The code fixture must genuinely scroll horizontally').toBeGreaterThan(120)
  const frameBox = await frame.boundingBox()
  if (!frameBox) throw new Error('Compact frame has no touch bounds')
  expect(sourcePoint.x - frameBox.x, 'Code gesture starts outside the drawer activation edge').toBeGreaterThan(24)
  await cdp.send('Input.synthesizeScrollGesture', { ...sourcePoint, xDistance: -120,
    gestureSourceType: 'touch', preventFling: true, speed: 500 })
  await expect.poll(() => source.evaluate(element => element.scrollLeft)).toBeGreaterThan(horizontalBefore.left + 40)
  expect(await drawerToggle.getAttribute('aria-expanded')).toBe('false')
  await fit('gesture-code-horizontal')

  const copy = transcript.getByRole('button', { name: 'Copy', exact: true }).last()
  const copyPoint = await reach(copy)
  const copyBox = await copy.boundingBox()
  const copyHandle = await copy.elementHandle()
  if (!copyBox || !copyHandle) throw new Error('Transcript Copy has no native target')
  const edgeCopy = { x: Math.max(frameBox.x + 2, copyBox.x + 2), y: copyPoint.y }
  expect(edgeCopy.x - frameBox.x, 'Copy is tapped inside the drawer activation edge').toBeLessThan(24)
  const copyEvents = await page.evaluateHandle(() => {
    const events: object[] = []
    const observe = (event: Event): void => {
      if (events.length >= 100) return
      const touch = event instanceof TouchEvent ? event.changedTouches[0] : undefined
      events.push({ type: event.type, cancelable: event.cancelable, prevented: event.defaultPrevented,
        x: touch?.clientX, y: touch?.clientY,
        target: event.target instanceof Element ? event.target.closest('button')?.getAttribute('aria-label') : null })
    }
    const kinds = ['touchstart', 'touchmove', 'touchend', 'click']
    for (const kind of kinds) document.addEventListener(kind, observe, { passive: true })
    return { events, dispose: () => { for (const kind of kinds) document.removeEventListener(kind, observe) } }
  })
  try {
    await cdp.send('Input.synthesizeTapGesture', { ...edgeCopy, gestureSourceType: 'touch', duration: 60 })
    await expect.poll(() => copyHandle.getAttribute('aria-label')).toBe('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('native_horizontal_1')
    expect(await drawerToggle.getAttribute('aria-expanded')).toBe('false')
    await fit('gesture-edge-copy-tap')
    await expect.poll(() => copyHandle.getAttribute('aria-label'), { timeout: 5_000 }).toBe('Copy')
    expect(copyPoint.x - frameBox.x, 'Baseline Copy movement starts outside the drawer edge').toBeGreaterThan(24)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [copyPoint] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: copyPoint.x + 2, y: copyPoint.y + 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => copyHandle.getAttribute('aria-label')).toBe('Copied')
    await fit('gesture-copy-small-jitter-baseline')
    await expect.poll(() => copyHandle.getAttribute('aria-label'), { timeout: 5_000 }).toBe('Copy')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [edgeCopy] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: edgeCopy.x + 2, y: edgeCopy.y + 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => copyHandle.getAttribute('aria-label')).toBe('Copied')
    expect(await drawerToggle.getAttribute('aria-expanded')).toBe('false')
    await fit('gesture-edge-copy-small-jitter')
  } finally {
    try {
      if (output) await writeFile(join(output, 'gesture-copy-events.json'),
        JSON.stringify(await copyEvents.evaluate(state => state.events), null, 2) + '\n')
      await copyEvents.evaluate((state) => { state.dispose() })
    } finally { await copyEvents.dispose(); await copyHandle.dispose() }
  }

  const transcriptBox = await transcript.boundingBox()
  if (!transcriptBox) throw new Error('Conversation has no touch bounds')
  const visibleBottom = Math.min(transcriptBox.y + transcriptBox.height, await page.evaluate(() => visualViewport!.height))
  const visibleHeight = visibleBottom - transcriptBox.y
  expect(visibleHeight, 'The portrait transcript has room for a native vertical gesture').toBeGreaterThan(120)
  const edgePoint = { x: frameBox.x + 12, y: transcriptBox.y + visibleHeight * 0.35 }
  expect(await transcript.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y)
    return hit !== null && element.contains(hit)
  }, edgePoint), 'The original conversation receives touches at the drawer edge').toBe(true)
  const verticalBefore = await transcript.evaluate(element => element.scrollTop)
  expect(verticalBefore, 'The long transcript starts below its top').toBeGreaterThan(100)
  await cdp.send('Input.synthesizeScrollGesture', { ...edgePoint, yDistance: Math.min(160, visibleHeight * 0.4),
    gestureSourceType: 'touch', preventFling: true, speed: 500 })
  await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(verticalBefore - 40)
  expect(await drawerToggle.getAttribute('aria-expanded')).toBe('false')
  await fit('gesture-edge-vertical')

  const touchTrace = await page.evaluateHandle(() => {
    const events: unknown[] = []
    const kinds = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const
    const record = (event: TouchEvent) => {
      if (events.length >= 100) return
      const touch = event.touches[0] ?? event.changedTouches[0]
      events.push({ type: event.type, cancelable: event.cancelable, prevented: event.defaultPrevented,
        x: touch?.clientX, y: touch?.clientY, time: performance.now(),
        target: event.target instanceof Element ? event.target.className : null })
    }
    for (const kind of kinds) document.addEventListener(kind, record, { passive: true })
    return { events, dispose: () => { for (const kind of kinds) document.removeEventListener(kind, record) } }
  })
  try {
    await cdp.send('Input.synthesizeScrollGesture', { ...edgePoint, xDistance: Math.min(180, frameBox.width * 0.6),
      gestureSourceType: 'touch', preventFling: true, speed: 500 })
    await expect.poll(() => drawerToggle.getAttribute('aria-expanded')).toBe('true')
  } finally {
    try {
      if (output) await writeFile(join(output, 'gesture-edge-open-events.json'),
        JSON.stringify(await touchTrace.evaluate(trace => trace.events), null, 2) + '\n')
    } finally {
      try { await touchTrace.evaluate((trace) => { trace.dispose() }) }
      finally { await touchTrace.dispose() }
    }
  }
  await fit('gesture-edge-open')
  const drawer = frame.locator(':scope > div[data-open="true"]').filter({ has: page.getByRole('navigation', { name: 'Panels' }) })
  const drawerBox = await drawer.boundingBox()
  if (!drawerBox) throw new Error('Opened drawer has no touch bounds')
  await cdp.send('Input.synthesizeScrollGesture', { x: drawerBox.x + drawerBox.width * 0.8,
    y: edgePoint.y, xDistance: -drawerBox.width * 0.6,
    gestureSourceType: 'touch', preventFling: true, speed: 500 })
  await expect.poll(() => drawerToggle.getAttribute('aria-expanded')).toBe('false')
  await fit('gesture-drawer-close')
  receipts.push({ name: 'gesture-scroll-ownership', horizontalBefore: horizontalBefore.left,
    horizontalAfter: await source.evaluate(element => element.scrollLeft), verticalBefore,
    verticalAfter: await transcript.evaluate(element => element.scrollTop) })
  await selectFixtureSession(id)
  await page.locator('[data-composer-card] textarea:enabled').waitFor()
  if (featurePages) {
    await rotate('0')
    await tap(page.getByRole('button', { name: 'Open right sidebar', exact: true }))
    await tap(page.locator('[data-sidebar-right-guide-entry="memory"]'))
    const memory = page.locator('[data-sidebar-right-tab]').filter({ has: page.getByRole('textbox', { name: 'Search memory', exact: true }) })
    await tap(memory.getByRole('button', { name: 'New', exact: true }))
    const key = memory.getByLabel('Key', { exact: true })
    const summary = memory.getByLabel('Summary', { exact: true })
    const content = memory.getByLabel('Content', { exact: true })
    await memory.getByLabel('Kind', { exact: true }).selectOption('guidance')
    await key.fill('physical-android-entry')
    await summary.fill('Android native memory acceptance')
    await content.fill('Long content retains its draft during native rotation. '.repeat(30))
    await hideKeyboard()
    await fit('memory-editor-portrait', [key, summary, content, memory.getByRole('button', { name: 'Save', exact: true })])
    await rotate('1')
    expect(await content.inputValue()).toContain('native rotation')
    await fit('memory-editor-landscape', [content, memory.getByRole('button', { name: 'Save', exact: true })])
    await tap(memory.getByRole('button', { name: 'Save', exact: true }))
    await rotate('0')
    await memory.getByRole('textbox', { name: 'Search memory', exact: true }).fill('physical-android-entry')
    await hideKeyboard()
    await tap(memory.getByRole('button', { name: /physical-android-entry/ }))
    await fit('memory-expanded-portrait', [memory.getByRole('button', { name: 'Edit memory', exact: true })])
    await tap(memory.getByRole('button', { name: 'Edit memory', exact: true }))
    await summary.fill('Edited on Android')
    await hideKeyboard()
    await fit('memory-edited-ready', [content, memory.getByRole('button', { name: 'Save', exact: true })])
    await tap(memory.getByRole('button', { name: 'Save', exact: true }))
    await memory.getByText('Edited on Android', { exact: true }).waitFor()
    const disclosure = memory.getByRole('button', { name: /physical-android-entry/ })
    if (await disclosure.getAttribute('aria-expanded') !== 'true') await tap(disclosure)
    await tap(memory.getByRole('button', { name: 'Delete', exact: true }))
    await fit('memory-delete-confirmation', [memory.getByRole('button', { name: 'Delete', exact: true })])
    await tap(memory.getByRole('button', { name: 'Delete', exact: true }))
    await expect.poll(() => disclosure.count()).toBe(0)

    await tap(page.getByRole('button', { name: 'New tab', exact: true }))
    await tap(page.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /New terminal/ }))
    const terminal = page.getByRole('textbox', { name: 'Terminal', exact: true })
    await expect.poll(() => terminal.isEditable()).toBe(true)
    await tap(terminal)
    await terminal.pressSequentially('printf android-native-proof > android-terminal.txt')
    await terminal.press('Enter')
    await expect.poll(() => readFile(join(world.workspaceCwd, 'android-terminal.txt'), 'utf8').catch(() => '')).toBe('android-native-proof')
    await hideKeyboard()
    await fit('terminal-portrait', [terminal])
    await rotate('1')
    await fit('terminal-landscape', [terminal])
    await rotate('0')

    owned.preview = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(request.url === '/second' ? '<h1>Second Android page</h1>'
        : '<h1>Android preview</h1><a href="/second">Continue</a>')
    })
    await new Promise<void>((resolve, reject) => {
      owned.preview!.once('error', reject)
      owned.preview!.listen(0, '127.0.0.1', () => { owned.preview!.removeListener('error', reject); resolve() })
    })
    const address = owned.preview.address()
    if (address === null || typeof address === 'string') throw new Error('Android preview server did not bind')
    const previewSocket = `tcp:${address.port}`
    await adb('reverse', '--no-rebind', previewSocket, previewSocket)
    owned.previewSocket = previewSocket
    await tap(page.getByRole('button', { name: 'New tab', exact: true }))
    await tap(page.locator('[data-sidebar-right-guide-entry="browser"]'))
    const addressField = page.getByRole('textbox', { name: 'Enter an HTTP(S) address', exact: true })
    const go = page.getByRole('button', { name: 'Go', exact: true })
    await addressField.fill(`http://127.0.0.1:${address.port}/first`)
    await hideKeyboard()
    await tap(go)
    const frame = page.frameLocator('[data-sidebar-browser-frame]')
    await frame.getByRole('heading', { name: 'Android preview', exact: true }).waitFor()
    await fit('browser-portrait', [addressField, go])
    await tap(frame.getByRole('link', { name: 'Continue', exact: true }))
    await frame.getByRole('heading', { name: 'Second Android page', exact: true }).waitFor()
    await fit('browser-unobservable-navigation')
    await rotate('1')
    await fit('browser-landscape', [addressField, go])
    await reach(page.locator('[data-sidebar-browser-frame]'))
    await fit('browser-landscape-reading')
    await rotate('0')
    await tap(page.getByRole('button', { name: 'Collapse right sidebar', exact: true }))
  }
  if (documentPages) {
    const documents = [
      { name: 'Android-native-preview.pdf', bytes: pdfFixture(6), media: '[data-document-pdf-host]' },
      { name: 'Android-native-notes.txt', bytes: new TextEncoder().encode('Android document preview proof. 中文内容可阅读。'), media: 'pre' },
    ]
    for (const document of documents) {
      const target = await world.ctx.userDocs.resolveTarget({ name: document.name })
      await world.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(document.bytes); controller.close() },
      }))
    }
    await rotate('0')
    await openDrawer(page)
    await tap(page.getByRole('button', { name: 'Documents', exact: true }))
    const manager = page.getByRole('dialog', { name: 'Document Manager', exact: true })
    await manager.getByText(documents[0]!.name, { exact: true }).waitFor()
    for (const document of documents) {
      await tap(manager.getByRole('button', { name: `Preview ${document.name}`, exact: true }))
      const preview = page.getByRole('dialog', { name: `Preview: ${document.name}`, exact: true })
      const media = preview.locator(document.media)
      const back = preview.getByRole('button', { name: 'Back to documents', exact: true })
      await media.waitFor({ state: 'visible' })
      const kind = document.name.endsWith('.pdf') ? 'pdf' : 'text'
      if (kind === 'pdf') {
        await preview.locator('[data-pdf-text]').getByText('Selectable PDF text', { exact: true }).first().waitFor()
        const canvas = preview.locator('canvas').first()
        await canvas.waitFor({ state: 'visible' })
        expect(await canvas.evaluate((element: HTMLCanvasElement) => {
          if (element.width === 0 || element.height === 0) return false
          const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
          return pixels.some((value, index) => index % 4 !== 3 && value < 200)
        })).toBe(true)
      }
      await fit(`documents-${kind}-portrait`, [back, media])
      await rotate('1')
      await fit(`documents-${kind}-landscape`, [back, media])
      if (kind === 'pdf') {
        const secondPage = preview.locator('[data-pdf-page="2"]')
        const text = secondPage.locator('[data-pdf-text]').getByText('Selectable PDF text', { exact: true })
        await reach(text)
        const separation = await text.evaluate((element) => {
          const text = element.getBoundingClientRect()
          const frame = element.closest('[data-document-zoom-frame]')!
          const controls = frame.querySelector('[data-document-zoom-controls]')!.getBoundingClientRect()
          const scrollport = frame.querySelector('[data-document-zoom-scrollport]')!.getBoundingClientRect()
          return { textGap: controls.top - text.bottom, scrollportGap: controls.top - scrollport.bottom }
        })
        expect(separation.textGap, JSON.stringify(separation)).toBeGreaterThanOrEqual(-1)
        expect(separation.scrollportGap, JSON.stringify(separation)).toBeGreaterThanOrEqual(-1)
        await secondPage.locator('canvas').waitFor({ state: 'visible' })
        await fit('documents-pdf-landscape-page-two', [media])
      }
      await tap(back)
      await preview.waitFor({ state: 'detached' })
      await rotate('0')
    }
    await tap(manager.getByRole('button', { name: 'More actions', exact: true }))
    await tap(page.getByRole('dialog', { name: 'More actions', exact: true }).getByRole('button', { name: 'New Folder', exact: true }))
    const folder = page.getByRole('dialog', { name: 'New Folder', exact: true })
    await folder.getByRole('textbox').fill('Android folder draft')
    await hideKeyboard()
    await rotate('1')
    await fit('documents-folder-landscape', [folder.getByRole('textbox'), folder.getByRole('button', { name: 'Create', exact: true })])
    const fieldLabel = await folder.getByText('Folder name', { exact: true }).evaluate((element) => {
      const label = element.getBoundingClientRect()
      const body = element.closest('[data-documents-sheet-scrollport]')!.getBoundingClientRect()
      return { above: body.top - label.top, below: label.bottom - body.bottom }
    })
    expect(Math.max(fieldLabel.above, fieldLabel.below), 'Folder label remains beside its reachable input').toBeLessThanOrEqual(1)
    await tap(folder.getByRole('button', { name: 'Cancel', exact: true }))
    await rotate('0')
    await tap(manager.getByRole('button', { name: 'Close', exact: true }))
  }
  await openDrawer(page)
  await page.getByRole('navigation', { name: 'Panels' }).waitFor()
  const panels = await page.getByRole('navigation', { name: 'Panels' }).getByRole('button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''))
  expect(panels.length).toBeGreaterThan(0)
  for (const name of panels) {
    await openDrawer(page)
    await page.getByRole('navigation', { name: 'Panels' }).waitFor()
    await tap(page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name, exact: true }))
    await fit('panel-' + name.replaceAll(/[^a-zA-Z0-9]/g, '-'))
  }
  await openDrawer(page)
  await tap(page.getByRole('button', { name: 'Settings', exact: true }))
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.waitFor()
  const sections = await settings.getByRole('navigation').getByRole('button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''))
  expect(sections.length).toBeGreaterThan(0)
  async function inspectSettings(prefix = 'settings'): Promise<void> {
    for (const tab of sections) {
      const control = settings.getByRole('navigation').getByRole('button', { name: tab, exact: true })
      await tap(control)
      await expect.poll(() => control.getAttribute('aria-current')).toBe('true')
      await expect.poll(() => settings.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.left >= -1 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1
      })).toBe(true)
      await fit(prefix + '-' + tab.toLowerCase())
    }
  }
  await inspectSettings()
  if (systemMatrix) {
    await setSystem('accelerometer_rotation', '0')
    await setSystem('user_rotation', '0')
    for (const dpi of [540, 480, 440, 400, 320]) {
      await density(String(dpi))
      await expect.poll(() => page.evaluate(() => screen.width), { timeout: 15_000 }).toBeCloseTo(Math.round(physicalWidth * 160 / dpi), 0)
      for (const scale of ['1', '1.3', '2']) {
        await font(scale)
        await inspectSettings(`density-${dpi}-font-${scale}`)
      }
    }
    await density(originalDensity)
    await font(originalFont)
  }
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
  const input = page.locator('[data-composer-card] textarea:enabled')
  await input.waitFor()
  await hideKeyboard()
  await expect.poll(() => page.evaluate(() => visualViewport!.height / screen.height)).toBeGreaterThan(0.65)
  const before = await page.evaluate(() => visualViewport!.height)
  await tap(input)
  await expect.poll(() => page.evaluate(() => visualViewport!.height), { timeout: 15_000 }).toBeLessThan(before - 80)
  await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
  const rotationDraft = 'Android keyboard and rotation acceptance draft'
  await cdp.send('Input.insertText', { text: rotationDraft })
  await expect.poll(() => input.inputValue()).toBe(rotationDraft)
  await fit('keyboard-portrait')
  await expect.poll(() => input.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.top >= visualViewport!.offsetTop - 1 && box.bottom <= visualViewport!.offsetTop + visualViewport!.height + 1
  })).toBe(true)
  await setSystem('accelerometer_rotation', '0')
  await setSystem('user_rotation', '1')
  await expect.poll(() => page.evaluate(() => screen.width > screen.height), { timeout: 15_000 }).toBe(true)
  await settleVisibleViewport()
  if (await page.evaluate(() => innerHeight - visualViewport!.height < 80)) await tap(input)
  if (process.env.DSH_ANDROID_OCCLUDING_IME === '1') {
    await expect.poll(() => page.evaluate(() => visualViewport!.height), { timeout: 15_000 }).toBeLessThan(60)
    await fit('native-keyboard-covers-page')
    await pressBack()
  } else {
    await expect.poll(() => page.evaluate(() => innerHeight - visualViewport!.height), { timeout: 15_000 }).toBeGreaterThan(80)
  }
  await expect.poll(() => page.evaluate(() => visualViewport!.height), { timeout: 15_000 }).toBeGreaterThan(60)
    .catch(async (error: unknown) => {
      await fit('landscape-failure')
      if (output) await writeFile(join(output, 'failed-device-receipts.json'), JSON.stringify(receipts, null, 2) + '\n')
      throw error
    })
  await expect.poll(() => input.inputValue()).toBe(rotationDraft)
  await fit('keyboard-landscape-send', [page.getByRole('button', { name: 'Send message', exact: true })],
    process.env.DSH_ANDROID_OCCLUDING_IME !== '1')
  await reach(input)
  if (process.env.DSH_ANDROID_OCCLUDING_IME !== '1') {
    await tap(input)
    await expect.poll(() => page.evaluate(() => innerHeight - visualViewport!.height), { timeout: 15_000 }).toBeGreaterThan(80)
    await reach(input)
  }
  await expect.poll(() => input.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const viewport = visualViewport!
    return box.top >= viewport.offsetTop - 1 && box.bottom <= viewport.offsetTop + viewport.height + 1
  })).toBe(true)
  await fit(process.env.DSH_ANDROID_OCCLUDING_IME === '1' ? 'keyboard-dismissed-landscape' : 'keyboard-landscape', [input],
    process.env.DSH_ANDROID_OCCLUDING_IME !== '1')
  await setSystem('user_rotation', '0')
  await expect.poll(() => page.evaluate(() => screen.width < screen.height), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    visualViewport!.width <= screen.width + 1 && visualViewport!.height > screen.height * 0.2), { timeout: 15_000 }).toBe(true)
  if (await page.evaluate(() => innerHeight - visualViewport!.height < 80)) await tap(input)
  await expect.poll(() => page.evaluate(() => innerHeight - visualViewport!.height), { timeout: 15_000 }).toBeGreaterThan(80)
  await expect.poll(() => input.inputValue()).toBe(rotationDraft)
  await fit('keyboard-returned-portrait', [input])
  if (workbenchPages) {
    await hideKeyboard()
    const names = ['Android first pane', 'Android second pane']
    for (const name of names) {
      const path = join(world.workspaceCwd, name)
      await mkdir(path)
      const workspace = await world.ctx.workspaceRegistry.create(path)
      const session = await seedSession(world, gestureHistory(), name, undefined, path)
      await workspace.attachSession(session)
      await world.ctx.agents.resume({ resumeSessionId: session,
        setup: agentCtx => world.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    }
    await rotate('1')
    const closeRight = page.getByRole('button', { name: 'Close right sidebar', exact: true })
    if (await closeRight.isVisible()) await tap(closeRight)
    const toolbar = page.locator('[data-workbench-toolbar]')
    await tap(toolbar.getByRole('button', { name: 'Select workbench', exact: true }))
    await tap(page.getByRole('menuitem', { name: /My workbench/u }))
    for (const name of names) {
      await tap(toolbar.getByRole('button', { name: 'Add conversation', exact: true }))
      const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
      await tap(picker.getByRole('button').filter({ hasText: name }).first())
      await picker.waitFor({ state: 'hidden' })
    }
    const panes = page.locator('[data-workbench] [data-session-pane]')
    await expect.poll(() => panes.count()).toBe(2)
    const ids = await panes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
    const shortToolbar = await toolbar.evaluate(node => ({
      viewport: { width: innerWidth, height: innerHeight },
      height: node.getBoundingClientRect().height,
      controls: [...node.querySelectorAll('button')].map((control) => {
        const box = control.getBoundingClientRect()
        return { label: control.getAttribute('aria-label') ?? control.textContent,
          width: box.width, height: box.height, center: box.y + box.height / 2 }
      }).filter(control => control.width > 0 && control.height > 0),
    }))
    if (shortToolbar.viewport.width >= 800 && shortToolbar.viewport.height <= 480) {
      expect(shortToolbar.height, JSON.stringify(shortToolbar)).toBeLessThanOrEqual(52)
      const centers = shortToolbar.controls.map(control => control.center)
      expect(Math.max(...centers) - Math.min(...centers), JSON.stringify(shortToolbar)).toBeLessThanOrEqual(1)
      for (const control of shortToolbar.controls) {
        expect(control.width, JSON.stringify(control)).toBeGreaterThanOrEqual(44)
        expect(control.height, JSON.stringify(control)).toBeGreaterThanOrEqual(44)
      }
    }
    console.info('[native-workbench-short-toolbar]', JSON.stringify(shortToolbar))
    await fit('workbench-two-panes-landscape')
    for (const pane of await panes.all()) await expectVisibleControl(pane.locator('textarea').first())
    for (const [index, paneId] of ids.entries()) {
      const pane = page.locator(`[data-session-pane="${paneId}"]`)
      const draft = pane.locator('textarea:enabled').first()
      const send = pane.getByRole('button', { name: 'Send message', exact: true })
      await tap(draft)
      await expect.poll(() => page.evaluate(() => innerHeight - visualViewport!.height), { timeout: 15_000 }).toBeGreaterThan(80)
      await expect.poll(() => draft.evaluate(element => element === document.activeElement)).toBe(true)
      const text = `Native draft belonging to pane ${index}`
      await cdp.send('Input.insertText', { text })
      await expect.poll(() => draft.inputValue()).toBe(text)
      const fitsWithKeyboard = await draft.evaluate(element =>
        visualViewport!.height >= element.getBoundingClientRect().height)
      if (fitsWithKeyboard || process.env.DSH_ANDROID_OCCLUDING_IME !== '1') {
        await fit(`workbench-pane-${index}-keyboard-input`, [draft], true)
        await fit(`workbench-pane-${index}-keyboard-send`, [send], true)
      } else {
        await fit(`workbench-pane-${index}-keyboard-occluded`, [], true)
      }
      await hideKeyboard()
      await fit(`workbench-pane-${index}-keyboard-restored`, [draft, send])
      expect(await draft.inputValue()).toBe(text)
    }
    await rotate('0')
    for (const [index, name] of names.entries()) {
      await tap(toolbar.getByRole('tab').filter({ hasText: name }))
      const pane = page.locator(`[data-session-pane="${ids[index]}"]`)
      const draft = pane.locator('textarea').first()
      expect(await draft.inputValue()).toBe(`Native draft belonging to pane ${index}`)
      await fit(`workbench-portrait-pane-${index}-input`, [draft])
      await fit(`workbench-portrait-pane-${index}-send`, [pane.getByRole('button', { name: 'Send message', exact: true })])
    }
    await rotate('1')
    await expect.poll(() => panes.count()).toBe(2)
    for (const [index, paneId] of ids.entries()) {
      const draft = page.locator(`[data-session-pane="${paneId}"] textarea`).first()
      expect(await draft.inputValue()).toBe(`Native draft belonging to pane ${index}`)
      await fit(`workbench-pane-${index}-restored`, [draft])
    }
    await hideKeyboard()
    for (const [index, paneId] of ids.entries()) {
      const pane = page.locator(`[data-session-pane="${paneId}"]`)
      const draft = pane.locator('textarea').first()
      expect(await draft.inputValue()).toBe(`Native draft belonging to pane ${index}`)
      await fit(`workbench-pane-${index}-keyboard-dismissed`)
      await expectVisibleControl(draft)
    }
  }
  expect(failures).toEqual([])
  if (output) await writeFile(join(output, 'user-device-receipts.json'), JSON.stringify(receipts, null, 2) + '\n')
}, 600_000)
