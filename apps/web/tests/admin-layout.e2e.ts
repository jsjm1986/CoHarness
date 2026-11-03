/** Built Admin layout and failed-query presentation over authenticated Gateway HTTP. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { Locator } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { installAdminComputerFixture } from './admin-computer-fixture.ts'
import { loadConfig } from '../../../gateway/src/config.ts'
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
import type { RuntimeTarget } from '../../../gateway/src/instances.ts'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/admin-layout', import.meta.url))

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

it('keeps admin form controls aligned inside their sections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-layout-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => db.close())
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_STATE_ROOT: join(root, 'state') })
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
      state: async () => savedState,
      invoke: async function* () { throw new Error('fixture') },
      saveState: async () => ({ ...savedState, revision: '2' }),
    }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const project = await deps.projects.create({ name: 'UI fixture', createdBy: admin.id })
    const adminHandler = createAdminApiHandler(deps)
    const proxy = createProxyHandlers(deps)
    cleanup.push(() => { proxy.close() })
    installAdminComputerFixture(deps)
    const server = createGatewayServer(deps, {
      ...proxy,
      adminRoot: resolve('gateway/public/admin'),
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
    ])

    expect(errors).toEqual([])
  } finally {
    for (const clean of cleanup.reverse()) await clean()
  }
}, 120_000)
