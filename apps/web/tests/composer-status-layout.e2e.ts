/** Keyless browser acceptance of the assembled composer and its plugin status trigger. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, dismissAdminAndroidKeyboard, screenshotAdminPage, tapAndroidImeKey,
} from './admin-android-browser.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation } from './responsive-browser.ts'
import {
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

const FIXTURE = join(REPO_ROOT, 'apps/web/tests/snapshots/live-interactions/session.jsonl')
const SNAPSHOTS = join(REPO_ROOT, 'apps/web/tests/snapshots/composer-status-layout')
const MODE = webSnapshotMode()
const ANDROID = adminAndroidEndpoint !== undefined
const LANDSCAPE = process.env.DSH_COMPOSER_ANDROID_LANDSCAPE === '1'
const ANDROID_NARROW = !LANDSCAPE && process.env.DSH_COMPOSER_ANDROID_NARROW === '1'
const IME_SEND_POINT = process.env.DSH_ANDROID_IME_SEND_POINT
const ARTIFACTS = process.env.DSH_COMPOSER_ARTIFACTS
const CONTEXT = /^上下文已用 \d+%$/
const SHIELD = '维护通道'
const NOTICE = '常驻维护通道 · 全部操作留痕审计 · 写语句需当场批准'
const PORTRAITS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 430, height: 932 },
]

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() =>{  resolve() }))))
}

async function metrics(composer: Locator) {
  return composer.evaluate((element) => {
    const card = element.querySelector('[data-composer-card]')!.getBoundingClientRect()
    const row = element.querySelector('[data-composer-toolbar]')!
    const footer = element.querySelector('[data-composer-footer]')!
    function controls(lane: Element) {
      return Array.from(lane.querySelectorAll('button,select'))
        .filter(control => control.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"]') === null)
        .map((control) => {
          const { width, height, left, right, top, bottom } = control.getBoundingClientRect()
          return { width, height, left, right, top, bottom }
        })
        .filter(box => box.width > 0 && box.height > 0)
    }
    const tools = controls(row)
    const stats = controls(footer)
    const all = [...tools, ...stats]
    function deviation(line: typeof tools) {
      const centers = line.map(box => (box.top + box.bottom) / 2)
      return centers.length > 0 ? Math.max(...centers) - Math.min(...centers) : 0
    }
    return {
      width: innerWidth, height: innerHeight,
      rowWidth: row.getBoundingClientRect().width, rowHeight: row.getBoundingClientRect().height,
      gap: getComputedStyle(row.firstElementChild!).columnGap,
      compact: row.closest('[data-viewport="compact"],[data-composer-tool-layout="compact"]') !== null,
      allInside: all.every(box => box.left >= card.left - 0.5 && box.right <= card.right + 0.5),
      allTouchSize: all.every(box => box.width >= 43.9 && box.height >= 43.9),
      collision: all.some((one, index) => all.slice(index + 1).some(other =>
        one.left < other.right - 0.5 && one.right > other.left + 0.5
        && one.top < other.bottom - 0.5 && one.bottom > other.top + 0.5)),
      toolbarDeviation: deviation(tools), footerDeviation: deviation(stats),
      contextBelow: footer.querySelector('[data-composer-status="context"] button') !== null,
      shieldBelow: footer.querySelector('[data-composer-status="extension"] button') !== null,
    }
  })
}

function assertLayout(layout: Awaited<ReturnType<typeof metrics>>): void {
  expect(layout, JSON.stringify(layout)).toMatchObject({ allInside: true, collision: false })
  if (layout.compact) {
    expect(layout.allTouchSize, JSON.stringify(layout)).toBe(true)
    expect(layout.toolbarDeviation, JSON.stringify(layout)).toBeLessThan(1)
    expect(layout.footerDeviation, JSON.stringify(layout)).toBeLessThan(1)
  }
}

async function primarySize(action: Locator) {
  return action.evaluate((button) => {
    const { width, height, left, top } = button.getBoundingClientRect()
    const style = getComputedStyle(button)
    const inset = style.backgroundClip === 'content-box'
    const faceWidth = width - (inset ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0)
    const faceHeight = height - (inset ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0)
    const icon = button.querySelector('svg')!.getBoundingClientRect()
    const iconOffset = Math.max(
      Math.abs(icon.x + icon.width / 2 - (left + width / 2)),
      Math.abs(icon.y + icon.height / 2 - (top + height / 2)),
    )
    const edgeHit = button.contains(document.elementFromPoint(left + 1, top + height / 2))
    return { width, height, faceWidth, faceHeight, iconOffset, edgeHit }
  })
}

function assertPrimarySize(size: Awaited<ReturnType<typeof primarySize>>, faceLimit = 44): void {
  expect(size).toMatchObject({ width: 44, height: 44 })
  expect(size.faceWidth).toBeGreaterThanOrEqual(35.9)
  expect(size.faceWidth).toBeLessThanOrEqual(faceLimit + 0.01)
  expect(size.faceWidth).toBeCloseTo(size.faceHeight, 1)
  expect(size.iconOffset).toBeLessThan(0.5)
}

it.skipIf(MODE === 'record').each(['ordinary', 'steward'] as const)('fits the %s composer status controls and keeps their behavior', async (kind) => {
  const steward = kind === 'steward'
  const recorded = await readFile(FIXTURE, 'utf8')
  const [reply] = deriveReplayScript(parseSessionLog(recorded))
  const prompt = fixtureUserPrompts(recorded)[0]!
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-composer-status-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const runningFile = join(scratch, 'running')
  const override = join(scratch, 'replay.json')
  await writeFile(override, JSON.stringify([reply, { kind: 'hang', readyFile: runningFile }]))
  const world = await launchWebScaffold({
    replayFixture: FIXTURE,
    replayOverride: override,
    ...(ANDROID ? { remoteAuthority: `dsh-composer-${randomUUID().slice(0, 8)}.localhost` } : {}),
  })
  const run = promisify(execFile)
  const adb = async (...args: string[]): Promise<string> =>
    (await run('adb', ['-s', process.env.DSH_ANDROID_SERIAL!, ...args])).stdout.trim()
  const changeDisplay = (...args: string[]) => process.env.DSH_ANDROID_ROOT === '1'
    ? adb('shell', `su -c '${args.join(' ')}'`)
    : adb('shell', ...args)
  const setRotation = (value: string) => changeDisplay('cmd', 'window', 'user-rotation', 'lock', value)
  let restoreDevice: (() => Promise<void>) | undefined
  let narrowDevice: (() => Promise<() => Promise<void>>) | undefined
  let android: Awaited<ReturnType<typeof connectAdminAndroid>> | undefined
  let browser: Awaited<ReturnType<typeof responsiveBrowser.launch>> | undefined
  let page: Page | undefined
  onTestFinished(async () => {
    try { await page?.close() } finally {
      try { await (android ? android.close() : browser?.close()) } finally {
        try { await restoreDevice?.() } finally { await world.close() }
      }
    }
  })
  {
    android = ANDROID ? await connectAdminAndroid(world.authenticatedUrl) : undefined
    browser = android?.browser ?? await responsiveBrowser.launch()
    if (ANDROID) {
      const automatic = await adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation')
      const rotation = await adb('shell', 'settings', 'get', 'system', 'user_rotation')
      expect(automatic).toMatch(/^[01]$/)
      expect(rotation).toMatch(/^[0-3]$/)
      restoreDevice = async () => {
        try { await setRotation(rotation) }
        finally {
          if (automatic === '1') await changeDisplay('cmd', 'window', 'user-rotation', 'free')
        }
        expect(await adb('shell', 'settings', 'get', 'system', 'user_rotation')).toBe(rotation)
        expect(await adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation')).toBe(automatic)
      }
      await setRotation(LANDSCAPE ? '1' : '0')
      if (ANDROID_NARROW) {
        const density = await adb('shell', 'wm', 'density')
        const original = density.match(/Override density: (\d+)/)?.[1] ?? 'reset'
        const width = Number((await adb('shell', 'wm', 'size')).match(/Physical size: (\d+)x/)?.[1])
        expect(width).toBeGreaterThan(0)
        const restoreRotation = restoreDevice
        const restoreDensity = async () => {
          await changeDisplay('wm', 'density', original)
          await expect.poll(() => adb('shell', 'wm', 'density')).toBe(density)
        }
        narrowDevice = async () => {
          restoreDevice = async () => {
            try { await restoreDensity() } finally { await restoreRotation() }
          }
          await changeDisplay('wm', 'density', String(Math.round(160 * width / 320)))
          return async () => {
            await restoreDensity()
            restoreDevice = restoreRotation
          }
        }
      }
      const origin = new URL(world.authenticatedUrl).origin
      const androidPackage = process.env.DSH_ANDROID_BROWSER_PACKAGE ?? 'com.android.chrome'
      if (!/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/u.test(androidPackage)) {
        throw new Error('DSH_ANDROID_BROWSER_PACKAGE must be an Android application ID')
      }
      await adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
        '-d', world.authenticatedUrl, '--ez', 'create_new_tab', 'true',
        '-p', androidPackage)
      const foregroundPage = () => browser?.contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().startsWith(`${origin}/`))
      await expect.poll(() => foregroundPage() !== undefined, { timeout: 15_000 }).toBe(true)
      page = foregroundPage()!
      await page.addInitScript((language) => {
        Object.defineProperty(navigator, 'language', { get: () => language })
        Object.defineProperty(navigator, 'languages', { get: () => [language] })
      }, ZH_BROWSER_LOCALE)
    } else {
      page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        locale: ZH_BROWSER_LOCALE, colorScheme: 'dark', hasTouch: true, isMobile: responsiveMobileEmulation,
      })
    }
    const view = page
    view.setDefaultTimeout(15_000)
    const errors = watchConsole(view)
    const session = await seedSession(world, recorded, `composer-status-${kind}`, 'standard')
    const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
    await workspace.attachSession(session)
    const projectId = 26
    if (steward) {
      const projectName = '维护中枢'
      await view.route(/\/account\/api\/context(?:\?.*)?$/, route => route.fulfill({
        json: {
          user: { id: 7, username: 'fixture-admin', displayName: '验收账号', role: 'admin' },
          scope: { kind: 'project', projectId, projectName, mode: 'rw', steward: true },
          projects: [{ projectId, name: projectName, path: world.workspaceCwd, mode: 'rw', kind: 'steward' }],
        },
      }))
      await view.route(/\/api\/host\.describe(?:\?.*)?$/, async (route) => {
        const response = await route.fetch()
        const body = await response.json() as {
          result: { ok: true; value: { runtimeTarget?: unknown } } | { ok: false }
        }
        if (body.result.ok) body.result.value.runtimeTarget = { kind: 'project', projectId }
        await route.fulfill({ response, json: body })
      })
    }
    await view.goto(world.authenticatedUrl, { waitUntil: 'load' })
    const activate = (control: Locator) => ANDROID ? activateAdminControl(control) : control.click()
    if (ANDROID) {
      await view.bringToFront()
      await expect.poll(() => view.evaluate(landscape => (screen.width > screen.height) === landscape
        && (innerWidth > innerHeight) === landscape, LANDSCAPE),
      { timeout: 15_000 }).toBe(true)
      const openNav = view.getByRole('button', { name: '打开侧边栏', exact: true })
      await view.locator('[data-viewport]').first().waitFor()
      if (await openNav.isVisible()) await openNav.click()
    }
    const search = view.getByRole('button', { name: '搜索会话', exact: true })
    if (await search.getAttribute('aria-expanded') !== 'true') await activate(search)
    await view.getByRole('textbox', { name: /搜索(?:会话|电脑、工作区或对话)…/ }).fill(prompt)
    if (ANDROID) {
      await dismissAdminAndroidKeyboard()
      await expect.poll(() => view.evaluate(() => (visualViewport?.height ?? innerHeight) >= innerHeight - 1)).toBe(true)
    }
    await activate(view.getByRole('tree', { name: '搜索结果' }).getByRole('treeitem'))
    const card = view.locator('[data-composer-card]').filter({ visible: true })
    const composer = card.locator('..')
    const input = card.locator('textarea:enabled')
    const send = card.getByRole('button', { name: '发送消息', exact: true })
    const stop = card.getByRole('button', { name: '停止生成', exact: true })
    const context = composer.getByRole('button', { name: CONTEXT })
    const shield = composer.getByRole('button', { name: SHIELD, exact: true })
    const ends: string[] = []
    world.ctx.on('session/event', (_session, event) => {
      if (event.type === 'turn/end') ends.push(event.data.reason.kind)
    })
    if (steward) {
      await shield.waitFor()
      expect(await input.getAttribute('placeholder')).toBe('询问维护中枢，或描述要检查的对象…')
    } else expect(await shield.count()).toBe(0)
    const keyboardOpen = () => view.evaluate(() => innerHeight - (visualViewport?.height ?? innerHeight) > 75)
    async function revealToolbar(): Promise<void> {
      if (!ANDROID || !(await keyboardOpen())) return
      await dismissAdminAndroidKeyboard()
      await expect.poll(keyboardOpen).toBe(false)
    }
    async function sendDraft(): Promise<void> {
      if (ANDROID && LANDSCAPE && IME_SEND_POINT !== undefined && await keyboardOpen()) {
        expect(await input.getAttribute('enterkeyhint')).toBe('send')
        await capture('keyboard-send')
        await tapAndroidImeKey(IME_SEND_POINT)
      } else {
        await revealToolbar()
        await activate(send)
      }
    }
    if (ANDROID) {
      await revealToolbar()
      await activate(input)
      if (LANDSCAPE) await expect.poll(keyboardOpen).toBe(true)
    }
    await input.fill(prompt)
    await Promise.all([world.whenTurnSettled(), sendDraft()])
    await revealToolbar()
    await context.waitFor()
    const percent = (await context.getAttribute('aria-label'))!.match(/\d+%$/)![0]
    expect(await context.innerText()).toContain(percent)
    const report: object[] = []

    async function capture(label: string): Promise<void> {
      if (!ARTIFACTS) return
      await mkdir(ARTIFACTS, { recursive: true })
      await screenshotAdminPage(view, join(ARTIFACTS, `${ANDROID ? 'android' : responsiveBrowserName}-${kind}-${label}.png`))
    }

    if (ANDROID) {
      await settleLayout(view)
      const layout = await metrics(composer)
      assertLayout(layout)
      expect(layout.width > layout.height).toBe(LANDSCAPE)
      const primary = await primarySize(send)
      assertPrimarySize(primary, LANDSCAPE && layout.height <= 320 ? 38 : 44)
      const orientation = LANDSCAPE ? 'landscape' : 'portrait'
      report.push({ orientation, ...layout, primary, percent })
      await capture(orientation)
      if (steward) {
        await activate(shield)
        await view.getByRole('tooltip', { name: NOTICE }).waitFor()
        await activate(shield)
      }
      if (narrowDevice) {
        const restoreDensity = await narrowDevice()
        await expect.poll(() => view.evaluate(() => innerWidth)).toBe(320)
        await settleLayout(view)
        const narrow = await metrics(composer)
        assertLayout(narrow)
        const narrowPrimary = await primarySize(send)
        assertPrimarySize(narrowPrimary, 38)
        expect(narrowPrimary.faceWidth).toBeLessThan(primary.faceWidth)
        expect(narrow.contextBelow).toBe(true)
        expect(narrow.shieldBelow).toBe(steward)
        report.push({ orientation: 'narrow portrait', ...narrow, primary: narrowPrimary, percent })
        await capture('320')
        await activate(context)
        await view.getByRole('dialog', { name: '上下文已用', exact: true }).waitFor()
        await view.keyboard.press('Escape')
        if (steward) {
          await activate(shield)
          await view.getByRole('tooltip', { name: NOTICE }).waitFor()
          await capture('footer-notice')
          await activate(shield)
        }
        await restoreDensity()
      }
    } else {
      const rows = ['# Composer status placement', '', `Context reading: ${percent}`, '',
        '| width | context | maintenance shield |', '| --- | --- | --- |']
      const primaryRows = ['', '| primary action | touch target | face |', '| --- | --- | --- |']
      let narrowFaceWidth = 0
      for (const size of PORTRAITS) {
        await view.setViewportSize(size)
        await settleLayout(view)
        const layout = await metrics(composer)
        assertLayout(layout)
        const primary = await primarySize(send)
        assertPrimarySize(primary, size.width === 320 ? 38 : 44)
        if (size.width === 320) {
          narrowFaceWidth = primary.faceWidth
          primaryRows.push(`| 320px portrait | ${primary.width}×${primary.height}px | ${primary.faceWidth < primary.width ? 'inset' : 'full'} |`)
        }
        if (size.width === 430) expect(primary.faceWidth).toBeGreaterThan(narrowFaceWidth + 4)
        expect(layout.contextBelow, `${size.width}px`).toBe(steward ? size.width < 390 : size.width === 320)
        expect(layout.shieldBelow, `${size.width}px`).toBe(steward && size.width === 320)
        rows.push(`| ${size.width}px | ${layout.contextBelow ? 'footer' : 'toolbar'} | ${steward ? layout.shieldBelow ? 'footer' : 'toolbar' : 'absent'} |`)
        report.push({ ...layout, primary, percent })
        if (size.width === 320 || size.width === 390) await capture(String(size.width))
      }
      for (const size of [{ width: 667, height: 375 }, { width: 872, height: 230 }, { width: 1280, height: 900 }]) {
        await view.setViewportSize(size)
        await send.scrollIntoViewIfNeeded()
        await settleLayout(view)
        const layout = await metrics(composer)
        assertLayout(layout)
        const primary = await primarySize(send)
        assertPrimarySize(primary, size.height <= 320 ? 38 : 44)
        expect(primary.edgeHit).toBe(true)
        if (size.height <= 320) {
          primaryRows.push(`| ${size.width}×${size.height}px landscape | ${primary.width}×${primary.height}px | ${primary.faceWidth < primary.width ? 'inset' : 'full'} |`)
        } else expect(primary.faceWidth).toBeCloseTo(44, 1)
        expect(layout.contextBelow).toBe(false)
        expect(layout.shieldBelow).toBe(false)
        report.push({ ...layout, primary, percent })
        await capture(String(size.width))
      }
      await compareOrRefreshGolden(join(SNAPSHOTS, `${kind}.expected.md`), [...rows, ...primaryRows].join('\n'), MODE)

      for (let width = 320; width <= 430; width++) {
        await view.setViewportSize({ width, height: 844 })
        await settleLayout(view)
        if (width === 320) {
          await expect.poll(() => metrics(composer)).toMatchObject({ contextBelow: true, shieldBelow: steward })
        }
        const layout = await metrics(composer)
        assertLayout(layout)
        if (layout.shieldBelow) expect(layout.contextBelow).toBe(true)
      }
      await view.setViewportSize({ width: 430, height: 932 })
      await input.fill('保留的草稿')
      await activate(context)
      await context.focus()
      await view.setViewportSize(PORTRAITS[0]!)
      await expect.poll(async () => (await metrics(composer)).contextBelow).toBe(true)
      expect(await context.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await input.inputValue()).toBe('保留的草稿')
      await view.getByRole('dialog', { name: '上下文已用', exact: true }).waitFor()
      await view.keyboard.press('Escape')
      if (steward) {
        await activate(shield)
        await view.getByRole('tooltip', { name: NOTICE }).waitFor()
        await capture('footer-notice')
        await activate(shield)
      }
    }

    const idlePrimary = await primarySize(send)
    if (ANDROID) await activate(input)
    await input.fill('检查停止操作')
    await sendDraft()
    await revealToolbar()
    await expect.poll(() => existsSync(runningFile)).toBe(true)
    await stop.waitFor()
    expect(await card.locator('button[class*="primary"]').count()).toBe(1)
    const runningPrimary = await primarySize(stop)
    assertPrimarySize(runningPrimary)
    expect(runningPrimary.faceWidth).toBeCloseTo(idlePrimary.faceWidth, 1)
    expect(runningPrimary.edgeHit).toBe(true)
    report.push({ runningPrimary })
    await capture(ANDROID ? LANDSCAPE ? 'running-landscape' : 'running-portrait' : 'running')
    await input.fill('保留的草稿')
    await card.getByRole('button', { name: /^(?:排队|插话)发送$/ }).waitFor()
    expect(await stop.count()).toBe(0)
    await input.clear()
    await revealToolbar()
    await Promise.all([world.whenTurnSettled(), activate(stop)])
    expect(ends).toContain('aborted')
    expect(errors.pageErrors).toEqual([])
    const reportName = ANDROID ? `android-${kind}-${LANDSCAPE ? 'landscape' : 'portrait'}` : `${responsiveBrowserName}-${kind}`
    if (ARTIFACTS) await writeFile(join(ARTIFACTS, `${reportName}.json`), JSON.stringify(report, null, 2) + '\n')
  }
}, 120_000)
