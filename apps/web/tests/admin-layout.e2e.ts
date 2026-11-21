/** Built Admin layout and failed-query presentation over authenticated Gateway HTTP. */
import { completionBarrier } from './support.ts'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { installAdminComputerFixture } from './admin-computer-fixture.ts'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { ModelGovernanceService } from '../../../gateway/src/model-governance.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createProxyHandlers } from '../../../gateway/src/proxy.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'
import { NodeConfigurationStore } from '../../../gateway/src/node-config-store.ts'
import { isolatedNodeConfigurationAuthority } from '../../../gateway/tests/node-config-fixture.ts'
import { testConfig } from '../../../gateway/tests/test-config.ts'
import type { RuntimeTarget } from '../../../gateway/src/instances.ts'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/admin-layout', import.meta.url))
const screenshotDirectory = process.env.DSH_ADMIN_LAYOUT_SCREENSHOTS

interface Box { x: number; y: number; width: number; height: number }
const right = (box: Box) => box.x + box.width
const bottom = (box: Box) => box.y + box.height

const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element has no rendered box')
  return box
}

const inside = (inner: Box, outer: Box) => {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x)
  expect(right(inner)).toBeLessThanOrEqual(right(outer) + 1)
  expect(inner.y).toBeGreaterThanOrEqual(outer.y)
  expect(bottom(inner)).toBeLessThanOrEqual(bottom(outer) + 1)
}

const touchViewports = [
  { width: 320, height: 568, colorScheme: 'light' },
  { width: 360, height: 800, colorScheme: 'dark' },
  { width: 375, height: 667, colorScheme: 'light' },
  { width: 390, height: 844, colorScheme: 'dark', textSpacing: true },
  { width: 412, height: 915, colorScheme: 'light' },
  { width: 430, height: 932, colorScheme: 'dark' },
  { width: 540, height: 720, colorScheme: 'light' },
  { width: 667, height: 375, colorScheme: 'dark' },
  { width: 844, height: 390, colorScheme: 'light' },
  { width: 767, height: 900, colorScheme: 'light' },
  { width: 768, height: 900, colorScheme: 'dark' },
  { width: 769, height: 900, colorScheme: 'light' },
  { width: 839, height: 900, colorScheme: 'light' },
  { width: 840, height: 900, colorScheme: 'dark' },
  { width: 841, height: 900, colorScheme: 'light' },
] as const

async function expectPageFits(page: Page, width: number, context: string): Promise<void> {
  const measured = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(measured.width, context).toBe(width)
  expect(measured.scrollWidth, context).toBeLessThanOrEqual(width + 1)
}

async function applyTextSpacing(page: Page): Promise<void> {
  await page.addStyleTag({ content: `
    body * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
    p { margin-bottom: 2em !important; }
  ` })
}

async function captureTouchScreenshot(page: Page, width: number, name: string): Promise<void> {
  if (screenshotDirectory === undefined || (width !== 390 && width !== 844)) return
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({ path: join(screenshotDirectory, `${String(width)}-${name}.png`), animations: 'disabled' })
}

it('keeps admin controls inside their sections and navigation reachable on short screens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-layout-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => db.close())
    const cfg = testConfig(root)
    await mkdir(cfg.projectsRoot, { recursive: true })
    const governance = new ModelGovernanceService(db)
    const deps: GatewayDeps = { cfg, instances: new InstanceManager(db, cfg), auth: new AuthService(db, cfg),
      users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db), governance }
    const nodeConfiguration = new NodeConfigurationStore({ organizationId: 'organization-fixture', nodeId: 'node-fixture' }, cfg, {}, isolatedNodeConfigurationAuthority)
    await nodeConfiguration.initialize()
    deps.nodeConfiguration = nodeConfiguration
    const deploymentState = { mode: 'serving' as const, maintenanceEpoch: '12', writeEpoch: '1', reason: null,
      enteredAt: null, updatedAt: '2026-10-09', nodes: [], writersQuiesced: false }
    deps.maintenance = {
      administration: async () => ({ ...deploymentState, operations: [] }),
      state: async () => deploymentState, listOperations: async () => [],
      enterMaintenance: async () => deploymentState, exitMaintenance: async () => deploymentState,
      setNodeStatus: async () => { throw new Error('This layout scenario does not change a cluster node') },
      requestRestore: async () => { throw new Error('fixture') }, logOperation: async () => 'operation-fixture',
    }
    deps.backups = { list: async () => [], get: async () => { throw new Error('fixture') },
      record: async () => { throw new Error('fixture') }, setVerified: async () => { throw new Error('fixture') } }
    const savedState = { revision: '1', appliedRevision: '1', generation: null, observed: null, state: null }
    deps.pluginManagement = {
      target: async (_admin, input) => ({ nodeId: 'node-fixture', target: input as RuntimeTarget, generation: 12290 }),
      overview: async () => [],
      inventory: async () => [],
      state: async () => savedState,
      invoke: async function* () { throw new Error('fixture') },
      saveState: async () => ({ ...savedState, revision: '2' }),
    }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const project = await deps.projects.create({ name: 'UI fixture', createdBy: admin.id })
    const longProject = await deps.projects.create({
      name: '移动端项目布局验收 - Long project name with readable actions and configuration details', createdBy: admin.id,
    })
    const adminHandler = createAdminApiHandler(deps)
    const proxy = createProxyHandlers(deps)
    cleanup.push(() => { proxy.close() })
    installAdminComputerFixture(deps)
    const server = createGatewayServer(deps, {
      ...proxy,
      adminRoot: resolve(process.env.DSH_ADMIN_ASSET_ROOT ?? 'gateway/public/admin'),
      admin: async (req, res, user, path, body) => adminHandler(req, res, user, path, body),
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else done() })
    }))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; cfg.publicOrigins.push(base)
    const browser = await chromium.launch(); cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: 'light' })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/login`)
    await page.getByRole('textbox', { name: '用户名', exact: true }).fill('admin')
    await page.getByLabel('密码', { exact: true }).fill('fixture-password')
    expect(await page.getByText('用户名', { exact: true }).isVisible()).toBe(true)
    expect(await page.getByText('密码', { exact: true }).isVisible()).toBe(true)
    expect(await page.locator('form').getAttribute('method')).toBe('post')
    expect(await page.locator('form').getAttribute('action')).toBe('/login')
    const login = await page.request.post(`${base}/login`, { form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0 })
    if (login.status() !== 302) throw new Error(`login ${login.status()}`)

    // The SPA shell is never cached; hashed assets cache privately forever.
    const shell = await page.request.get(`${base}/admin`)
    expect(shell.headers()['cache-control']).toBe('no-store')

    // Plugins: the reload action shares the select's row and stays inside the card.
    await page.goto(`${base}/admin/plugins`)
    const pluginSection = page.locator('section.section', { has: page.getByLabel('插件管理对象') })
    const selectBox = await boxOf(pluginSection.getByLabel('插件管理对象'))
    const reloadBox = await boxOf(pluginSection.getByRole('button', { name: '重新读取' }))
    const pluginSectionBox = await boxOf(pluginSection)
    expect(Math.abs(bottom(selectBox) - bottom(reloadBox))).toBeLessThanOrEqual(4)
    inside(reloadBox, pluginSectionBox)
    // Free-form content sits in the padded body band, not against the card edge.
    expect(selectBox.x - pluginSectionBox.x).toBeGreaterThanOrEqual(16)

    // Deployment: the maintenance action sits in its own row below the reason field.
    await page.goto(`${base}/admin/deployment`)
    const deploySection = page.locator('section.section', { has: page.getByLabel('维护事由') })
    const deploySectionBox = await boxOf(deploySection)
    const reasonBox = await boxOf(deploySection.getByLabel('维护事由'))
    const enterBox = await boxOf(deploySection.getByRole('button', { name: '进入维护窗口' }))
    expect(enterBox.y).toBeGreaterThanOrEqual(bottom(reasonBox))
    inside(enterBox, deploySectionBox)
    expect(reasonBox.x - deploySectionBox.x).toBeGreaterThanOrEqual(16)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${base}/admin/users`)
    await page.getByRole('button', { name: '删除用户', exact: true }).first().waitFor()
    const account = await boxOf(page.locator('.sidebarFooter'))
    expect(bottom(account)).toBeLessThanOrEqual(720)
    await page.locator('.sidebarNav').getByRole('link', { name: '审计', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.locator('.sidebarNav').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    // Phone width: controls wrap instead of escaping their sections.
    await page.setViewportSize({ width: 390, height: 844 })
    for (const route of ['plugins', 'deployment']) {
      await page.goto(`${base}/admin/${route}`)
      await page.waitForLoadState('networkidle')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    }
    await page.goto(`${base}/admin/plugins`)
    const phoneSection = page.locator('section.section', { has: page.getByLabel('插件管理对象') })
    const phoneSectionBox = await boxOf(phoneSection)
    inside(await boxOf(phoneSection.getByLabel('插件管理对象')), phoneSectionBox)
    inside(await boxOf(phoneSection.getByRole('button', { name: '重新读取' })), phoneSectionBox)

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto(`${base}/admin/users`)
      await page.getByRole('button', { name: '删除', exact: true }).first().waitFor()
      const contrast = await page.locator('.statusBadge, .sectionMeta, .pageMeta, .fieldHint, .button-danger').evaluateAll((elements) => {
        const channels = (color: string): number[] => (color.match(/[\d.]+/g) ?? []).map(Number)
        const luminance = (rgb: number[]): number => rgb.slice(0, 3).reduce((sum, value, index) => {
          const channel = value / 255
          return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
            // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- Gateway browser types use a separate compiler program.
            * [0.2126, 0.7152, 0.0722][index]!
        }, 0)
        return elements.filter(element => element.getBoundingClientRect().height > 0).map((element) => {
          const style = getComputedStyle(element)
          const foreground = luminance(channels(style.color))
          let surface = element
          let backgroundColor = channels(style.backgroundColor)
          while (backgroundColor[3] === 0 && surface.parentElement !== null) {
            surface = surface.parentElement
            backgroundColor = channels(getComputedStyle(surface).backgroundColor)
          }
          const background = luminance(backgroundColor)
          return {
            label: element.textContent,
            ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
          }
        })
      })
      expect(contrast.length).toBeGreaterThan(0)
      for (const sample of contrast) expect(sample.ratio, `${colorScheme}: ${sample.label ?? ''}`).toBeGreaterThanOrEqual(4.5)

      await page.goto(`${base}/admin/projects/${String(project.id)}`)
      const configuration = page.locator('section', { has: page.locator('.projectConfigurationSummary') })
      await configuration.waitFor()
      const border = await configuration.evaluate((element) => {
        const style = getComputedStyle(element)
        return { leftWidth: style.borderLeftWidth, rightWidth: style.borderRightWidth,
          leftColor: style.borderLeftColor, rightColor: style.borderRightColor }
      })
      expect(border.leftWidth).toBe(border.rightWidth)
      expect(border.leftColor).toBe(border.rightColor)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    }

    if (webSnapshotMode() === 'refresh') await mkdir(SNAPSHOT_DIR, { recursive: true })
    const storageState = await page.context().storageState()
    for (const variant of touchViewports) {
      const viewport = { width: variant.width, height: variant.height }
      const compact = viewport.width <= 840
        || (viewport.width <= 1024 && viewport.width > viewport.height && viewport.height <= 420)
      const label = `${viewport.width}x${viewport.height} ${variant.colorScheme}`
      const textSpacing = 'textSpacing' in variant && variant.textSpacing
      const context = await browser.newContext({ viewport, storageState, hasTouch: true, isMobile: true,
        deviceScaleFactor: 2, colorScheme: variant.colorScheme, reducedMotion: textSpacing ? 'reduce' : 'no-preference' })
      try {
        const touchPage = await context.newPage()
        touchPage.on('pageerror', error => errors.push(`${label}: ${error.message}`))
        await touchPage.goto(`${base}/admin/users`)
        const newUser = touchPage.getByRole('button', { name: '新建用户', exact: true })
        await newUser.waitFor()
        await touchPage.getByRole('button', { name: compact ? '删除' : '删除用户', exact: true }).first().waitFor()
        if (textSpacing) await applyTextSpacing(touchPage)
        expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches), label).toBe(true)
        await expectPageFits(touchPage, viewport.width, `${label}: users`)
        const accountActions = touchPage.locator(compact ? '.mobileHeader .accountActions' : '.sidebarFooter .accountActions')
        const language = await boxOf(accountActions.getByRole('button', { name: '中文，切换为 English', exact: true }))
        const signOut = await boxOf(accountActions.getByRole('button', { name: '退出登录', exact: true }))
        inside(language, { x: 0, y: 0, ...viewport })
        inside(signOut, { x: 0, y: 0, ...viewport })
        expect(language.y, label).toBe(signOut.y)
        const actionTargets = await touchPage.locator('.compactActions .iconButton:visible').all()
        expect(actionTargets.length, label).toBeGreaterThan(0)
        for (const action of actionTargets) {
          const box = await boxOf(action)
          expect(box.width, label).toBeGreaterThanOrEqual(44)
          expect(box.height, label).toBeGreaterThanOrEqual(44)
        }
        if (!compact) {
          const table = touchPage.locator('.tableWrap.desktopOnly')
          const edit = table.getByRole('button', { name: '编辑用户', exact: true }).first()
          await edit.tap()
          await touchPage.getByRole('dialog', { name: '编辑 admin', exact: true }).getByRole('button', { name: '取消', exact: true }).tap()
          expect(await table.evaluate(element => element.scrollLeft), `${label}: table actions`).toBeGreaterThan(0)
        }
        await newUser.tap()
        const create = touchPage.getByRole('dialog', { name: '新建用户', exact: true })
        const username = create.getByRole('textbox', { name: '用户名', exact: true })
        await username.tap()
        await username.fill('mobile-layout-draft')
        expect(await username.getAttribute('aria-describedby'), label).toBeTruthy()
        expect(await username.evaluate(element => getComputedStyle(element).fontSize), label).toBe('16px')
        inside(await boxOf(create), { x: 0, y: 0, ...viewport })
        await expectPageFits(touchPage, viewport.width, `${label}: user form`)
        await captureTouchScreenshot(touchPage, viewport.width, 'user-form')
        if (viewport.width === 844) {
          const role = create.getByRole('combobox', { name: '角色', exact: true })
          await role.tap()
          const body = create.locator('.dialogBody')
          inside(await boxOf(role), await boxOf(body))
          expect(await body.evaluate(element => element.scrollTop), `${label}: remaining form controls`).toBeGreaterThan(0)
          await captureTouchScreenshot(touchPage, viewport.width, 'user-form-scrolled')
        }
        if (viewport.width === 390) {
          await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'mobile-user-form.expected.md'),
            await captureStableAria(touchPage, 'dialog[open]', root), webSnapshotMode())
          // A shorter layout viewport models the space available to a form, not an operating-system keyboard.
          await touchPage.setViewportSize({ width: viewport.width, height: 420 })
          await create.getByLabel('初始密码', { exact: true }).tap()
          inside(await boxOf(create.getByRole('button', { name: '取消', exact: true })), { x: 0, y: 0, width: viewport.width, height: 420 })
        }
        await create.getByRole('button', { name: '取消', exact: true }).tap()
        await touchPage.setViewportSize(viewport)
        if (compact) {
          const nav = touchPage.locator('.mobileNav')
          inside(await boxOf(nav), { x: 0, y: 0, ...viewport })
          await nav.getByRole('button', { name: '更多管理功能' }).tap()
          const more = touchPage.getByRole('dialog', { name: '更多管理功能' })
          await more.getByRole('link', { name: '部署', exact: true }).tap()
        } else {
          await touchPage.locator('.sidebarNav').getByRole('link', { name: '部署', exact: true }).tap()
        }
        await touchPage.waitForURL(`${base}/admin/deployment`)
        const maintenance = touchPage.locator('section.section', { has: touchPage.getByLabel('维护事由', { exact: true }) })
        await maintenance.getByLabel('维护事由', { exact: true }).waitFor()
        await expectPageFits(touchPage, viewport.width, `${label}: deployment`)
        const maintenanceBox = await boxOf(maintenance)
        inside(await boxOf(maintenance.getByLabel('维护事由', { exact: true })), maintenanceBox)
        inside(await boxOf(maintenance.getByRole('button', { name: '进入维护窗口' })), maintenanceBox)
        await touchPage.goto(`${base}/admin/projects/${String(longProject.id)}`)
        await touchPage.getByRole('heading', { name: longProject.name, exact: true }).waitFor()
        if (textSpacing) await applyTextSpacing(touchPage)
        await expectPageFits(touchPage, viewport.width, `${label}: long project name`)
        const title = touchPage.locator('.pageHeader h1')
        expect(await title.evaluate(element => element.scrollWidth - element.clientWidth), label).toBeLessThanOrEqual(1)
        await captureTouchScreenshot(touchPage, viewport.width, 'long-project')
        await touchPage.getByRole('button', { name: '重命名', exact: true }).tap()
        const rename = touchPage.getByRole('dialog', { name: '重命名项目' })
        expect(await rename.getByRole('textbox', { name: '项目名称' }).inputValue()).toBe(longProject.name)
        await rename.getByRole('button', { name: '取消', exact: true }).tap()
        if (viewport.width === 390) {
          await touchPage.goto(`${base}/admin/webhooks`)
          await touchPage.getByRole('button', { name: '注册端点', exact: true }).tap()
          const webhook = touchPage.getByRole('dialog', { name: '注册 Webhook 端点', exact: true })
          const prompt = webhook.getByRole('textbox', { name: '提示词模板', exact: true })
          await applyTextSpacing(touchPage)
          await prompt.tap()
          await prompt.fill('Check the repository and summarize the requested changes.')
          await prompt.press('Shift+Tab')
          await touchPage.keyboard.press('Tab')
          expect(await prompt.evaluate(element => element === document.activeElement)).toBe(true)
          const focusStyle = await prompt.evaluate((element) => {
            const style = getComputedStyle(element)
            return { fontSize: style.fontSize, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
          })
          expect(focusStyle).toEqual({ fontSize: '16px', outlineStyle: 'solid', outlineWidth: '2px' })
          await expectPageFits(touchPage, viewport.width, `${label}: webhook textarea`)
          await webhook.getByRole('button', { name: '取消', exact: true }).tap()
        }
      } finally { await context.close() }
    }
    for (const failure of [
      { route: 'audit', api: '**/admin/api/audit**', empty: '没有匹配的记录' },
      { route: 'models', api: '**/admin/api/model-registrations**', empty: '暂无个人登记记录' },
      { route: 'webhooks', api: '**/admin/api/webhook-endpoints**', empty: '尚无 Webhook 端点' },
    ]) {
      let requests = 0
      await page.route(failure.api, async (route) => {
        requests += 1
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          error: failure.route === 'webhooks' ? 'webhook-endpoints-unavailable' : 'fixture-query-unavailable',
        }) })
      })
      await page.goto(`${base}/admin/${failure.route}`)
      if (failure.route === 'models') await page.getByRole('button', { name: '个人登记', exact: true }).click()
      await page.getByRole('alert').filter({
        hasText: failure.route === 'webhooks' ? '服务暂不可用，请稍后重试。' : 'fixture-query-unavailable',
      }).waitFor()
      expect(await page.getByText(failure.empty, { exact: true }).count()).toBe(0)
      if (failure.route === 'webhooks') expect(await page.getByText('正在加载 Webhook 端点', { exact: true }).count()).toBe(0)
      expect(requests).toBe(1)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, `${failure.route}-query-failure.expected.md`),
        await captureStableAria(page, 'main', root), webSnapshotMode())
      await page.unroute(failure.api)
    }
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'audit-query-failure.expected.md', 'models-query-failure.expected.md', 'webhooks-query-failure.expected.md',
      'mobile-user-form.expected.md', 'route-load-failure.expected.md',
    ])

    expect(errors).toEqual([])

    await page.setViewportSize({ width: 1280, height: 720 })
    const sidebar = page.locator('aside.sidebar')
    const logout = sidebar.getByRole('button', { name: '退出登录' })
    inside(await boxOf(logout), { x: 0, y: 0, width: 1280, height: 720 })
    const audit = sidebar.getByRole('link', { name: '审计', exact: true })
    await audit.focus()
    inside(await boxOf(audit), { x: 0, y: 0, width: 1280, height: 720 })
    await audit.press('Enter')
    await page.waitForURL(`${base}/admin/audit`)
    await compareOrRefreshGolden(
      resolve('apps/web/tests/expected/admin-layout/sidebar-short.expected.md'),
      await sidebar.ariaSnapshot(),
      webSnapshotMode(),
    )
    await logout.click()
    await page.waitForURL(`${base}/login`)
  } finally {
    for (const clean of cleanup.reverse()) await clean()
  }
})

const modelPageScript = /\/admin\/assets\/ModelsPage-[\w-]+\.js$/u
const modelDetailsScript = /\/admin\/assets\/ModelsDetails-[\w-]+\.js$/u

it('preloads model resources after each owning view renders and reuses the secondary script', async () => {
  const fixture = await startAdminResponsiveFixture()
  const releaseUsers = completionBarrier()
  const releaseCatalog = completionBarrier()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    const login = await page.request.post(`${fixture.base}/login`, {
      form: { username: 'admin', password: 'fixture-password' }, headers: { origin: fixture.base }, maxRedirects: 0,
    })
    expect(login.status()).toBe(302)
    await page.route(url => url.pathname === '/admin/api/users', async (route) => {
      await releaseUsers.promise
      await route.continue()
    })
    await page.route(url => url.pathname === '/admin/api/model-settings', async (route) => {
      await releaseCatalog.promise
      await route.continue()
    })
    await page.addInitScript(() => {
      const markAfterRender = (name: string, visible: () => boolean) => {
        const ready = new MutationObserver(() => {
          if (!visible()) return
          requestAnimationFrame(() => performance.mark(name))
          ready.disconnect()
        })
        ready.observe(document, { childList: true, subtree: true })
      }
      markAfterRender('admin-users-rendered', () => document.querySelector('main .userLink') !== null)
      markAfterRender('admin-catalog-rendered', () => [...document.querySelectorAll('main button')]
        .some(button => button.textContent?.trim() === '添加组织 Provider'))
    })
    const modelScripts: string[] = []
    const detailsScripts: string[] = []
    const modelReads: string[] = []
    const tabReads: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (modelPageScript.test(url.pathname)) modelScripts.push(request.url())
      if (modelDetailsScript.test(url.pathname)) detailsScripts.push(request.url())
      if (url.pathname === '/admin/api/models') modelReads.push(request.url())
      if (url.pathname === '/admin/api/progress/digest-model' || url.pathname === '/admin/api/model-registrations'
        || url.pathname === '/admin/api/model-access') {
        tabReads.push(url.pathname)
      }
    })

    await page.goto(`${fixture.base}/admin/`)
    await page.locator('main .loadingState:visible').waitFor()
    expect(modelScripts).toEqual([])
    const script = page.waitForResponse(response => modelPageScript.test(new URL(response.url()).pathname), { timeout: 5_000 })
    releaseUsers.resolve()
    const preloaded = await script
    expect(preloaded.ok()).toBe(true)
    await preloaded.finished()
    await page.locator('main .userLink:visible').first().waitFor()
    const timing = await page.evaluate(url => ({
      usersRendered: performance.getEntriesByName('admin-users-rendered')[0]?.startTime,
      modelRequest: performance.getEntriesByName(url, 'resource')[0]?.startTime,
    }), preloaded.url())
    if (timing.usersRendered === undefined || timing.modelRequest === undefined) throw new Error('Missing Users render or Models request timing')
    expect(timing.modelRequest).toBeGreaterThanOrEqual(timing.usersRendered)
    expect(modelReads).toEqual([])

    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname === '/admin/api/model-settings'),
      page.getByRole('link', { name: '模型', exact: true }).click(),
    ])
    expect(modelScripts).toEqual([preloaded.url()])
    expect(detailsScripts).toEqual([])
    await expect.poll(() => modelReads.length).toBeGreaterThan(0)
    const details = page.waitForResponse(response => modelDetailsScript.test(new URL(response.url()).pathname), { timeout: 5_000 })
    releaseCatalog.resolve()
    const prepared = await details
    expect(prepared.ok()).toBe(true)
    await prepared.finished()
    await page.getByRole('button', { name: '添加组织 Provider', exact: true }).waitFor()
    const detailsTiming = await page.evaluate(url => ({
      catalogRendered: performance.getEntriesByName('admin-catalog-rendered')[0]?.startTime,
      detailsRequest: performance.getEntriesByName(url, 'resource')[0]?.startTime,
    }), prepared.url())
    if (detailsTiming.catalogRendered === undefined || detailsTiming.detailsRequest === undefined) throw new Error('Missing catalog render or model detail request timing')
    expect(detailsTiming.detailsRequest).toBeGreaterThanOrEqual(detailsTiming.catalogRendered)
    expect(tabReads).toEqual([])
    await page.getByRole('button', { name: '权限与计价', exact: true }).click()
    await page.getByRole('heading', { name: '进展梳理', exact: true }).waitFor()
    await expect.poll(() => [...tabReads].sort()).toEqual(['/admin/api/model-access', '/admin/api/progress/digest-model'])
    await page.getByRole('button', { name: '个人登记', exact: true }).click()
    await page.getByRole('form', { name: '个人登记筛选', exact: true }).waitFor()
    await expect.poll(() => [...tabReads].sort()).toEqual([
      '/admin/api/model-access', '/admin/api/model-registrations', '/admin/api/progress/digest-model',
    ])
    expect(detailsScripts).toEqual([prepared.url()])
  } finally {
    releaseUsers.resolve()
    releaseCatalog.resolve()
    try { await browser?.close() } finally { await fixture.close() }
  }
})

it('reads each model tab’s data while its shared script is pending', async () => {
  const fixture = await startAdminResponsiveFixture()
  const releaseDetails = completionBarrier()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    const login = await page.request.post(`${fixture.base}/login`, {
      form: { username: 'admin', password: 'fixture-password' }, headers: { origin: fixture.base }, maxRedirects: 0,
    })
    expect(login.status()).toBe(302)
    await page.route(modelDetailsScript, async (route) => {
      await releaseDetails.promise
      await route.continue()
    })
    await page.goto(`${fixture.base}/admin/models`)
    await page.getByRole('button', { name: '添加组织 Provider', exact: true }).waitFor()

    const [registrations] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/model-registrations', { timeout: 5_000 }),
      page.getByRole('button', { name: '个人登记', exact: true }).click(),
    ])
    expect(registrations.ok()).toBe(true)
    await page.locator('main').getByRole('status').filter({ hasText: '正在加载' }).waitFor()
    const [digest] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/progress/digest-model', { timeout: 5_000 }),
      page.getByRole('button', { name: '权限与计价', exact: true }).click(),
    ])
    expect(digest.ok()).toBe(true)
    await digest.finished()
    await page.evaluate(() => {
      const main = document.querySelector('main')!
      const observe = new MutationObserver(() => {
        const digestTitle = [...main.querySelectorAll('h2')].find(heading => heading.textContent === '进展梳理')
        if (digestTitle === undefined) return
        const digestSection = digestTitle.closest('section')!
        main.dataset.digestReadyAtMount = String(digestSection.querySelector('select') !== null)
        observe.disconnect()
      })
      observe.observe(main, { childList: true, subtree: true })
    })
    const details = page.waitForResponse(response => modelDetailsScript.test(new URL(response.url()).pathname), { timeout: 5_000 })
    releaseDetails.resolve()
    expect((await details).ok()).toBe(true)
    await page.getByRole('combobox', { name: '梳理模型', exact: true }).waitFor()
    expect(await page.locator('main').getAttribute('data-digest-ready-at-mount')).toBe('true')
    await page.getByRole('button', { name: '个人登记', exact: true }).click()
    await page.getByRole('form', { name: '个人登记筛选', exact: true }).waitFor()
  } finally {
    releaseDetails.resolve()
    try { await browser?.close() } finally { await fixture.close() }
  }
})

it('keeps a failed model script preload off the Users page and offers reload on navigation', async () => {
  const fixture = await startAdminResponsiveFixture()
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    const login = await page.request.post(`${fixture.base}/login`, {
      form: { username: 'admin', password: 'fixture-password' }, headers: { origin: fixture.base }, maxRedirects: 0,
    })
    expect(login.status()).toBe(302)
    let requests = 0
    let blocked = true
    await page.route(modelPageScript, async (route) => {
      requests += 1
      if (blocked) await route.abort('failed')
      else await route.continue()
    })
    await Promise.all([
      page.waitForEvent('requestfailed', request => modelPageScript.test(new URL(request.url()).pathname)),
      page.goto(`${fixture.base}/admin/`),
    ])
    await page.locator('main .userLink:visible').first().waitFor()
    expect(await page.getByRole('alert').filter({ hasText: '页面加载失败，请重新加载' }).count()).toBe(0)
    const models = page.getByRole('link', { name: '模型', exact: true })
    await models.click()
    await page.getByRole('alert').filter({ hasText: '页面加载失败，请重新加载' }).waitFor({ timeout: 5_000 })
    expect(await models.isVisible()).toBe(true)
    expect(requests).toBeGreaterThan(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'route-load-failure.expected.md'),
      await page.locator('main').ariaSnapshot(), webSnapshotMode())

    blocked = false
    await page.getByRole('button', { name: '重新加载页面', exact: true }).click()
    await page.getByRole('heading', { name: '模型治理', exact: true }).waitFor()
    expect(requests).toBeGreaterThan(1)
  } finally {
    try { await browser?.close() } finally { await fixture.close() }
  }
})
