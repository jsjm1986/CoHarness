/** Every built Admin page, including restricted recovery, at every declared touch/desktop viewport. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, firefox, webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, dismissAdminAndroidKeyboard, screenshotAdminPage } from './admin-android-browser.ts'
import { auditAdminTouchTargets, selectedAdminSizes } from './admin-responsive-state.ts'
import { auditResponsiveControl, auditResponsiveControls, responsiveControlAudit } from './responsive-controls.ts'

const viewports = adminAndroidEndpoint !== undefined ? [[0, 0] as const]
  : selectedAdminSizes
const screenshotDirectory = process.env.DSH_ADMIN_LAYOUT_SCREENSHOTS
const engines = process.env.DSH_ADMIN_ENGINES?.split(',') ?? ['chromium', 'webkit', 'firefox']

interface Scenario { id: string; path: string; title: RegExp; failure: string; actions?: string[]; empty?: string }
const scenarios: Scenario[] = [
  { id: 'users', path: '/users', title: /^用户管理$/, failure: '/users', actions: ['新建用户'], empty: '还没有用户' },
  { id: 'user-detail', path: '/users/1', title: /^用户 · /, failure: '/users/1', actions: ['编辑账号', '重置密码'] },
  { id: 'projects', path: '/projects', title: /^项目$/, failure: '/projects', actions: ['新建项目'], empty: '还没有项目' },
  { id: 'project-detail', path: '/projects/1', title: /移动验收/, failure: '/projects/1', actions: ['重命名', '配置额度', '启动实例'] },
  { id: 'plugins', path: '/plugins', title: /^插件$/, failure: '/plugins/inventory', empty: '此计算机上还没有任何空间' },
  { id: 'models', path: '/models', title: /^模型治理$/, failure: '/models', empty: '还没有组织模型' },
  { id: 'usage', path: '/usage', title: /^模型用量$/, failure: '/usage/overview', actions: ['配置额度'], empty: '本月暂无用量' },
  { id: 'documents', path: '/documents', title: /^文档$/, failure: '/documents', actions: ['查看详情'], empty: '没有匹配的文档' },
  { id: 'archives', path: '/archives', title: /^归档对话$/, failure: '/archives/records', empty: '没有匹配的对话' },
  { id: 'terminals', path: '/terminals', title: /^终端$/, failure: '/users', empty: '没有保留的终端。' },
  { id: 'ssh', path: '/ssh', title: /^SSH/, failure: '/ssh-targets', actions: ['注册目标'], empty: '尚无 SSH 目标' },
  { id: 'deployment', path: '/deployment', title: /^部署与迁移$/, failure: '/deployment' },
  { id: 'steward', path: '/steward', title: /^维护空间$/, failure: '/steward', empty: '暂无成员' },
  { id: 'webhooks', path: '/webhooks', title: /Webhook/, failure: '/webhook-endpoints', actions: ['注册端点'], empty: '尚无 Webhook 端点' },
  { id: 'desktops', path: '/desktops', title: /^桌面协调$/, failure: '/desktops', actions: ['详情'], empty: '没有桌面资源' },
  { id: 'remote-desktops', path: '/remote-desktops', title: /^远程桌面$/, failure: '/remote-desktop/endpoints',
    actions: ['添加端点', '签发授权'], empty: '尚未配置远程桌面端点' },
  { id: 'audit', path: '/audit', title: /^审计日志$/, failure: '/audit', empty: '没有匹配的记录' },
  { id: 'governance-recovery', path: '/governance-recovery', title: /^恢复组织管理$/, failure: '' },
  { id: 'governance-recovery-local', path: '/governance-recovery/local', title: /^本机 Runtime 恢复审核$/, failure: '' },
  { id: 'computer-contexts', path: '/documents', title: /^文档$/, failure: '/documents' },
]

async function fits(page: Page, label: string): Promise<void> {
  const measure = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll<HTMLElement>('dialog[open], .pageHeader, .section, .errorBanner, .nodeConfigurationHelp code')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .filter((element) => { const box = element.getBoundingClientRect(); return box.x < -1 || box.right > innerWidth + 1 })
      .map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 100) })) }))
  const viewport = page.viewportSize()
  const expectedWidth = viewport?.width ?? await page.evaluate(() => screen.width)
  const overflow = measure.width > expectedWidth + 1 ? await page.evaluate(width => [...document.querySelectorAll<HTMLElement>('body *')]
    .filter(element => !element.closest('.tableWrap'))
    .filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right,
      text: element.textContent?.slice(0, 100) })).slice(-20), expectedWidth) : []
  expect(Math.abs(measure.width - expectedWidth), `${label}: mobile layout viewport expanded ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(1)
  expect(measure.scroll, `${label}: document overflow`).toBeLessThanOrEqual(measure.width + 1)
  expect(measure.clipped, `${label}: content outside viewport`).toEqual([])
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  await page.locator('.loadingState:visible').waitFor({ state: 'hidden' })
}

async function inspectControls(page: Page, keyboard: boolean): Promise<void> {
  const unnamed = await page.locator('input:not([type="hidden"]), select, textarea').evaluateAll(elements => elements
    .filter(element => element.getBoundingClientRect().height > 0)
    .filter(element => !(element as HTMLInputElement).labels?.length && !element.getAttribute('aria-label')
      && !element.getAttribute('aria-labelledby'))
    .map(element => element.outerHTML.slice(0, 200)))
  expect(unnamed, 'visible form controls have accessible labels').toEqual([])
  for (const table of await page.locator('.tableWrap:visible').all()) {
    if (!await table.evaluate(element => element.scrollWidth > element.clientWidth + 1)) continue
    expect(await table.getAttribute('role')).toBe('region')
    expect(await table.getAttribute('aria-label')).not.toBe('')
    expect(await table.getAttribute('tabindex')).toBe('0')
    if (keyboard) {
      await table.focus()
      // WebKit cancels a native scroll when keyup precedes its first animation frame.
      await page.keyboard.down('ArrowRight')
      try { await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0) }
      catch (cause) {
        const state = await table.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return {
            label: element.getAttribute('aria-label'), focused: document.activeElement === element,
            active: document.activeElement?.outerHTML.slice(0, 300), scrollLeft: element.scrollLeft,
            width: element.clientWidth, scrollWidth: element.scrollWidth, overflowX: getComputedStyle(element).overflowX,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          }
        })
        throw new Error(`Keyboard table scrolling failed: ${JSON.stringify(state)}`, { cause })
      } finally { await page.keyboard.up('ArrowRight') }
    }
  }
  if (adminAndroidEndpoint === undefined) await auditResponsiveControls(page, page.locator('body'), 'Admin page controls')
  await auditAdminTouchTargets(page, page.locator('body'))
}

async function screenshot(page: Page, engine: string, scenario: string, width: number, state: string): Promise<void> {
  if (screenshotDirectory === undefined || state !== 'failed' && adminAndroidEndpoint === undefined && ![390, 844, 1280].includes(width)) return
  await mkdir(screenshotDirectory, { recursive: true })
  await screenshotAdminPage(page, join(screenshotDirectory, `${engine}-${scenario}-${width}-${state}.png`))
}

const launchers: Readonly<Record<string, typeof chromium>> = adminAndroidEndpoint === undefined
  ? { chromium, webkit, firefox } : { android: chromium }
for (const [engine, launcher] of Object.entries(launchers)) {
  if (adminAndroidEndpoint === undefined && !engines.includes(engine)) continue
  describe(`Admin all pages (${engine})`, () => {
    let fixture: Awaited<ReturnType<typeof startAdminResponsiveFixture>>
    let browser: Browser
    let android: Awaited<ReturnType<typeof connectAdminAndroid>> | undefined
    const results: Array<{ page: string; viewport: string; status: 'passed' | 'failed'; states: string[]; error?: string }> = []
    beforeAll(async () => {
      fixture = await startAdminResponsiveFixture()
      if (adminAndroidEndpoint === undefined) browser = await launcher.launch(engine === 'firefox'
        ? { firefoxUserPrefs: { 'network.proxy.type': 0 } } : {})
      else { android = await connectAdminAndroid(fixture.base); browser = android.browser }
    })
    afterAll(async () => {
      if (android === undefined) await browser?.close(); else await android.close()
      await fixture?.close()
      if (process.env.DSH_ADMIN_COVERAGE_OUTPUT !== undefined) {
        await mkdir(process.env.DSH_ADMIN_COVERAGE_OUTPUT, { recursive: true })
        await writeFile(join(process.env.DSH_ADMIN_COVERAGE_OUTPUT, `${engine}.json`), JSON.stringify(results, null, 2) + '\n')
      }
    })
    for (const scenario of scenarios) it(`${scenario.id}: loaded, actions and failure at each viewport`, async () => {
      for (const [emulatedWidth, emulatedHeight] of viewports) {
        fixture.state.mode = 'loaded'; fixture.state.recovery = 'loaded'
        fixture.state.scope = scenario.id === 'deployment' ? 'organization' : 'local'
        const context = adminAndroidEndpoint !== undefined ? browser.contexts()[0]
          : await browser.newContext({ viewport: { width: emulatedWidth, height: emulatedHeight },
            hasTouch: emulatedWidth < 1024, isMobile: engine !== 'firefox' && emulatedWidth < 1024,
            colorScheme: emulatedWidth % 2 === 0 ? 'dark' : 'light', reducedMotion: 'reduce', locale: 'zh-CN' })
        if (context === undefined) throw new Error('Android CDP did not expose its active browser context')
        const page = await context.newPage()
        if (adminAndroidEndpoint !== undefined) await page.bringToFront()
        const errors: string[] = []
        const states: string[] = []
        let viewportLabel = `${emulatedWidth}x${emulatedHeight}`
        page.on('pageerror', error => errors.push(error.message))
        page.setDefaultTimeout(10_000)
        const checkpoint = async (state: string, keyboard = false): Promise<void> => {
          const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
          let failure: string | undefined
          try {
            await fits(page, `${scenario.id} ${viewportLabel} ${state}`)
            await screenshot(page, engine, scenario.id, await page.evaluate(() => innerWidth), `${state}-start`)
            await inspectControls(page, keyboard)
            await screenshot(page, engine, scenario.id, await page.evaluate(() => innerWidth), state)
            states.push(state)
          } catch (error) { failure = String(error); throw error }
          finally {
            const output = process.env.DSH_ADMIN_COVERAGE_OUTPUT
            if (output !== undefined) {
              await mkdir(output, { recursive: true })
              await appendFile(join(output, `${engine}-states.jsonl`), JSON.stringify({
                page: scenario.id, route: new URL(page.url()).pathname, viewport: viewportLabel, state, pointer: coarse ? 'coarse' : 'fine',
                status: failure === undefined ? 'passed' : 'failed',
                checker: adminAndroidEndpoint === undefined ? responsiveControlAudit : { version: 'admin-native-page-v1' },
                checks: [...(adminAndroidEndpoint === undefined ? responsiveControlAudit.checks : []),
                  'page-horizontal-fit', 'form-labels', 'table-semantics', ...(coarse ? ['admin-coarse-target-44'] : [])],
                ...(failure === undefined ? {} : { error: failure }),
              }) + '\n')
            }
          }
        }
        try {
          await page.goto(`${fixture.base}/login`)
          await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(0)
          const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          viewportLabel = `${width}x${height}`
          const login = await context.request.post(`${fixture.base}/login`, { form: { username: 'admin', password: 'fixture-password' },
            headers: { origin: fixture.base }, maxRedirects: 0 })
          expect(login.status()).toBe(302)
          await page.goto(`${fixture.base}/admin${scenario.path}`)
          await settle(page)
          expect(errors, `${scenario.id}: initial browser exceptions`).toEqual([])
          expect(await page.getByRole('heading', { level: 1, name: scenario.title }).count(), `${scenario.id}: heading`).toBe(1)
          expect(await page.locator('.errorBanner:visible').allTextContents(), `${scenario.id}: loaded errors`).toEqual([])
          await checkpoint('loaded', width >= 1024)
          if (scenario.id === 'deployment') {
            const content = page.locator('section', { has: page.getByRole('heading', { name: '项目内容库', exact: true }) })
            const computer = content.getByRole('combobox', { name: '电脑', exact: true })
            const verify = content.getByRole('button', { name: '核验存储位置', exact: true })
            await computer.waitFor()
            const [field, action] = await Promise.all([computer.boundingBox(), verify.boundingBox()])
            if (field === null || action === null) throw new Error('Missing content storage controls')
            expect(action.height, 'content storage control heights').toBeCloseTo(field.height, 0)
            if (action.x > field.x + field.width - 1) {
              expect(action.x - field.x - field.width, 'content storage horizontal gap').toBeGreaterThanOrEqual(9)
              expect(action.y, 'content storage row alignment').toBeCloseTo(field.y, 0)
            } else {
              expect(action.y - field.y - field.height, 'content storage vertical gap').toBeGreaterThanOrEqual(9)
            }
            await computer.selectOption(fixture.remoteNodeId)
            const receipt = page.waitForResponse((reply) => {
              const url = new URL(reply.url())
              return url.pathname === '/admin/api/deployment/node-content' && url.searchParams.get('dshNode') === fixture.remoteNodeId
            })
            await activateAdminControl(verify)
            expect((await receipt).status()).toBe(503)
            await content.getByRole('alert').waitFor()
            await computer.selectOption(fixture.nodeId)
            await activateAdminControl(verify)
            await content.getByRole('status').getByText(fixture.contentDirectory, { exact: true }).waitFor()
            await checkpoint('content-storage-verified')
          }
          if (width === 390) await page.addStyleTag({ content: 'body *{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}' })
          await fits(page, `${scenario.id} ${width} loaded`)
          expect(await page.title()).toContain(await page.getByRole('heading', { level: 1 }).innerText())
          if (width === 390) await checkpoint('text-spacing')
          for (const name of scenario.actions ?? []) {
            const action = page.getByRole('button', { name, exact: name !== '查看详情' }).filter({ visible: true }).first()
            await activateAdminControl(action)
            const dialog = page.getByRole('dialog')
            if (scenario.id === 'desktops') await page.getByRole('heading', { name: /^授权与排队 · / }).waitFor({ state: 'visible' })
            else await dialog.waitFor({ state: 'visible' })
            await settle(page)
            await fits(page, `${scenario.id} ${width} ${name}`)
            if (scenario.id === 'desktops') await screenshot(page, engine, scenario.id, width, 'detail')
            if (await dialog.count() > 0) {
              if (scenario.id === 'project-detail' && name === '配置额度') {
                await activateAdminControl(dialog.getByRole('radio', { name: /^项目独立额度/ }).locator('..'))
                await dialog.getByRole('combobox').first().selectOption('custom')
              }
              const input = dialog.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([readonly]):enabled, textarea:not([readonly]):enabled').first()
              const last = dialog.locator('button:enabled').last()
              if (await input.count() > 0) {
                await activateAdminControl(input)
                await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
                if (adminAndroidEndpoint !== undefined) {
                  await expect.poll(() => page.evaluate(() => visualViewport!.height), { timeout: 15_000 })
                    .toBeLessThan(height - 80)
                  const keyboardViewport = await page.evaluate(() => visualViewport!.height)
                  const actionHeight = await last.evaluate(element => element.getBoundingClientRect().height)
                  if (keyboardViewport + 1 < actionHeight) {
                    await expect.poll(() => input.evaluate((element) => {
                      const rect = element.getBoundingClientRect(), viewport = window.visualViewport!
                      return Math.min(rect.bottom, viewport.offsetTop + viewport.height) - Math.max(rect.top, viewport.offsetTop)
                    })).toBeGreaterThan(0)
                    await input.fill('123')
                    await dismissAdminAndroidKeyboard()
                    await expect.poll(() => page.evaluate(() => visualViewport!.height)).toBeGreaterThan(keyboardViewport + actionHeight)
                    expect(await input.inputValue()).toBe('123')
                  }
                }
              }
              if (adminAndroidEndpoint === undefined) {
                await auditResponsiveControl(page, last, `${scenario.id}: dialog action`)
                const box = await last.boundingBox()
                expect(box?.y, `${scenario.id}: dialog action reachable`).toBeGreaterThanOrEqual(0)
                expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height + 1)
              } else {
                await last.evaluate((element) => { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }) })
                await expect.poll(() => last.evaluate((element) => {
                  const rect = element.getBoundingClientRect()
                  const viewportTop = visualViewport?.offsetTop ?? 0
                  const viewportBottom = viewportTop + (visualViewport?.height ?? innerHeight)
                  return { belowTop: rect.top >= viewportTop - 1, aboveBottom: rect.bottom <= viewportBottom + 1 }
                }), { message: 'dialog action fits the settled physical viewport' }).toEqual({ belowTop: true, aboveBottom: true })
              }
              await checkpoint(name)
              await page.keyboard.press('Escape')
              await dialog.waitFor({ state: 'hidden' })
            } else await checkpoint(name)
          }
          if (scenario.id === 'plugins' || scenario.id === 'terminals') {
            await page.getByRole('combobox', { name: scenario.id === 'plugins' ? '插件管理对象' : '终端运行范围' })
              .selectOption(`user:${fixture.adminId}`)
            await settle(page)
            expect(await page.locator('.errorBanner:visible').allTextContents(), 'selected Runtime loads').toEqual([])
            await fits(page, `${scenario.id} selected Runtime`)
            await screenshot(page, engine, scenario.id, width, 'runtime')
            if (scenario.id === 'plugins') {
              await activateAdminControl(page.locator('.matrixAdvanced > summary'))
              await page.getByLabel('条目 ID', { exact: true }).waitFor({ state: 'visible' })
              await fits(page, 'manual plugin entry fields')
              await screenshot(page, engine, scenario.id, width, 'manual-entry')
              await checkpoint('manual-entry')
            }
            if (scenario.id === 'terminals') {
              const close = page.getByRole('button', { name: '关闭终端', exact: true })
              await activateAdminControl(close)
              await checkpoint('terminal-close-confirm')
              await page.keyboard.press('Escape')
            }
            await checkpoint('selected-runtime')
          }
          if (scenario.id === 'models') {
            for (const view of ['权限与计价', '个人登记']) {
              await page.getByRole('button', { name: view, exact: true }).click()
              await settle(page); await fits(page, `${scenario.id} ${view}`)
              await screenshot(page, engine, scenario.id, width, view === '个人登记' ? 'registrations' : 'governance')
              if (view === '权限与计价') {
                await activateAdminControl(page.getByRole('button', { name: '配置模型治理', exact: true }).filter({ visible: true }).first())
                await page.getByRole('dialog').waitFor({ state: 'visible' })
                await fits(page, 'model pricing form')
                await screenshot(page, engine, scenario.id, width, 'pricing')
                await checkpoint('pricing-dialog')
                await page.keyboard.press('Escape')
                await page.getByRole('dialog').waitFor({ state: 'hidden' })
              }
              await checkpoint(view)
            }
          }
          if (scenario.id === 'archives') {
            const open = page.getByRole('button', { name: /^查看 / }).filter({ visible: true }).first()
            await activateAdminControl(open)
            await settle(page); await fits(page, 'archive detail')
            await checkpoint('detail')
            await page.keyboard.press('Escape')
          }
          if (!scenario.id.startsWith('governance-recovery')) {
            if (scenario.id === 'steward') {
              await activateAdminControl(page.getByRole('checkbox', { name: /^授予 / }).filter({ visible: true }).first().locator('..'))
              await page.getByRole('dialog').waitFor({ state: 'visible' })
              await fits(page, 'steward qualification confirmation')
              await checkpoint('qualification-dialog')
              await page.keyboard.press('Escape')
              await page.getByRole('dialog').waitFor({ state: 'hidden' })
            }
            await page.goto(`${fixture.base}/admin/computers/${fixture.nodeId}${scenario.path}`)
            await settle(page)
            expect(await page.getByRole('heading', { level: 1, name: scenario.title }).count(), 'same page in selected computer').toBe(1)
            expect(await page.locator('.errorBanner:visible').allTextContents(), 'selected computer errors').toEqual([])
            await fits(page, `${scenario.id} local computer`)
            await checkpoint('local-computer')
            fixture.state.scope = 'organization'
            await page.reload(); await settle(page)
            const computerControl = page.locator('.pageHeaderComputer')
            const computer = computerControl.getByRole('button', { name: /^管理电脑：/u })
            const refresh = computerControl.getByRole('button', { name: '刷新电脑列表', exact: true })
            await computer.waitFor({ state: 'visible' })
            expect(await refresh.isVisible()).toBe(false)
            await activateAdminControl(computer)
            const openPanel = computerControl.locator('.computerPanel:visible, dialog[open]')
            await refresh.waitFor({ state: 'visible' })
            await expect.poll(() => refresh.getAttribute('aria-disabled')).toBeNull()
            const center = openPanel.getByRole('button', { name: /中心电脑/u })
            await center.waitFor({ state: 'visible' })
            expect(await center.getAttribute('aria-current')).toBe('true')
            await openPanel.getByRole('button', { name: `${fixture.remoteName} 未连接` }).waitFor({ state: 'visible' })
            const replied = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/deployment/nodes/access'))
            await activateAdminControl(refresh)
            expect((await replied).ok()).toBe(true)
            const overflow = await openPanel.evaluate((element) => {
              const { top, bottom, left, right } = element.getBoundingClientRect()
              const viewport = window.visualViewport
              const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0
              return Math.max(
                x - left,
                y - top,
                right - x - (viewport?.width ?? innerWidth),
                bottom - y - (viewport?.height ?? innerHeight),
              )
            })
            expect(overflow).toBeLessThanOrEqual(1)
            await activateAdminControl(center)
            await refresh.waitFor({ state: 'hidden' })
            await fits(page, `${scenario.id} organization computer`)
            await screenshot(page, engine, scenario.id, width, 'organization')
            await checkpoint('organization-computer')
            fixture.state.scope = 'local'
            await page.goto(`${fixture.base}/admin/computers/${fixture.remoteNodeId}${scenario.path}`)
            await settle(page)
            expect(await page.getByRole('alert').filter({ hasText: '当前入口已不能访问此环境，页面和未保存内容仍保留' }).count()).toBe(1)
            expect(await page.locator('.adminRouteContent[aria-disabled="true"]').getAttribute('inert')).toBe('')
            await fits(page, `${scenario.id} unavailable computer`)
            await checkpoint('unavailable-computer')
            await page.goto(`${fixture.base}/admin${scenario.path}`)
            await settle(page)
          }
          if (scenario.id === 'governance-recovery') {
            await activateAdminControl(page.getByRole('button', { name: /^审核账号 / }))
            await page.getByRole('combobox', { name: '账号登录' }).selectOption('restore')
            await page.getByLabel('新密码', { exact: true }).fill('review-password')
            await fits(page, `${scenario.id} ${width} review`)
            await checkpoint('account-review')
            await page.getByRole('button', { name: '取消编辑' }).click()
            fixture.state.recovery = 'idle'
            await page.reload(); await settle(page)
            expect(await page.getByText('当前没有组织恢复审核').count()).toBe(1)
            await checkpoint('idle')
            fixture.state.recovery = 'error'
          } else if (scenario.id === 'governance-recovery-local') {
            await page.getByRole('button', { name: '查看此 Runtime' }).click()
            await page.getByText('指定本机数据位置', { exact: true }).click()
            await page.getByLabel('工作目录绝对路径').fill('/local/retained-home')
            await fits(page, `${scenario.id} ${width} local binding`)
            await checkpoint('local-recovery-binding')
            await page.getByLabel('工作目录绝对路径').fill('')
            fixture.state.recovery = 'idle'
            await page.reload(); await settle(page)
            await page.getByText('此页没有记录', { exact: true }).waitFor()
            await checkpoint('empty')
            fixture.state.recovery = 'error'
          } else {
            if (scenario.empty) {
              if (scenario.id === 'terminals') {
                await page.getByRole('combobox', { name: '终端运行范围' }).selectOption(`user:${fixture.adminId}`)
                await settle(page)
                fixture.state.mode = 'empty'
                await activateAdminControl(page.getByRole('button', { name: '刷新终端清单', exact: true }))
                await page.getByText('没有保留的终端。', { exact: true }).waitFor()
              } else {
                fixture.state.mode = 'empty'
                await page.reload(); await settle(page)
                if (scenario.id === 'models') await activateAdminControl(page.getByRole('button', { name: '权限与计价', exact: true }))
              }
              await page.getByText(scenario.empty, { exact: true }).waitFor()
              expect(await page.locator('.errorBanner:visible').allTextContents(), `${scenario.id}: empty errors`).toEqual([])
              await checkpoint('empty')
            }
            fixture.state.mode = 'error'; fixture.state.failurePath = scenario.failure
          }
          await page.reload(); await settle(page)
          expect(await page.locator('.errorBanner:visible').count(), `${scenario.id}: error surfaced`).toBeGreaterThan(0)
          await fits(page, `${scenario.id} ${width} error`)
          await checkpoint('error')
          if (scenario.id === 'computer-contexts') {
            fixture.state.mode = 'loaded'; fixture.state.scope = 'organization'
            for (const [prefix, label] of [['/admin', 'central'], [`/admin/computers/${fixture.nodeId}`, 'computer']] as const) {
              await page.goto(`${fixture.base}${prefix}/qa-unknown-page`)
              await page.getByRole('heading', { name: '找不到此管理页面', exact: true }).waitFor()
              const returnLink = page.getByRole('link', { name: '返回用户管理', exact: true })
              expect((await returnLink.getAttribute('href'))?.replace(/\/$/u, '')).toBe(prefix)
              await checkpoint(`unknown-page-${label}`)
              await activateAdminControl(returnLink)
              await page.getByRole('heading', { name: '用户管理', exact: true }).waitFor()
            }
            await page.goto(`${fixture.base}/admin/computers/${fixture.remoteNodeId}/documents`)
            await settle(page)
            await page.getByRole('button', { name: `管理电脑：${fixture.remoteName}`, exact: true }).waitFor({ state: 'visible' })
            expect((await page.locator('.errorBanner:visible').allTextContents()).join(' ')).toContain('无法连接所选电脑')
            await fits(page, 'offline computer')
            await screenshot(page, engine, scenario.id, width, 'offline')
            await checkpoint('offline-computer')
            await page.goto(`${fixture.base}/admin/computers/invalid/documents`)
            await page.getByRole('alert').waitFor({ state: 'visible' })
            expect(await page.getByRole('link', { name: '返回中心电脑' }).getAttribute('href')).toBe('/admin/')
            await fits(page, 'invalid computer')
            await screenshot(page, engine, scenario.id, width, 'invalid')
            await checkpoint('invalid-computer')
          }
          expect(errors, `${scenario.id} ${width}: browser exceptions`).toEqual([])
          results.push({ page: scenario.id, viewport: viewportLabel, status: 'passed', states })
        } catch (error) {
          results.push({ page: scenario.id, viewport: viewportLabel, status: 'failed', states, error: String(error) })
          await screenshot(page, engine, scenario.id, emulatedWidth, 'failed')
          throw error
        } finally { if (adminAndroidEndpoint === undefined) await context.close(); else await page.close() }
      }
    })
  })
}
