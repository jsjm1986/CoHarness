/** Built Admin model views retain document-owned edits through internal navigation. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { loadConfig } from '../../../gateway/src/config.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { ModelGovernanceService } from '../../../gateway/src/model-governance.ts'
import { ORGANIZATION_MODEL_SETTINGS_SCHEMA } from '../../../gateway/src/organization-model-settings-schema.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createProxyHandlers } from '../../../gateway/src/proxy.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'
import { installAdminComputerFixture } from './admin-computer-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'

const EXPECTED = fileURLToPath(new URL('./expected/admin-model-view-drafts/', import.meta.url))

it.each(['desktop-light', 'mobile-dark'] as const)('retains model configuration drafts in the built %s Admin', async (variant) => {
  const root = await mkdtemp(join(tmpdir(), 'admin-model-view-drafts-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const db = openDb(join(root, 'gateway.sqlite'))
    cleanup.push(() => db.close())
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_STATE_ROOT: join(root, 'state') })
    const governance = new ModelGovernanceService(db)
    const view: ReturnType<ModelGovernanceService['describeOrganizationModelSettings']> = {
      writable: true, hasDocument: false,
      namespaces: [{ ns: 'llm-pi-ai', schema: ORGANIZATION_MODEL_SETTINGS_SCHEMA,
        value: { providers: {} }, base: { providers: {} }, user: { providers: {} },
        applies: 'live', secrets: [], revision: 1 }],
    }
    governance.describeOrganizationModelSettings = () => view
    governance.describeOrganizationCredentials = () => ({})
    const deps: GatewayDeps = { cfg, governance, instances: new InstanceManager(db, cfg),
      auth: new AuthService(db, cfg), users: new UserService(db, cfg),
      projects: new ProjectService(db, cfg), audit: new AuditService(db) }
    deps.progress = {
      digestModelSettings: async () => ({ model: null, candidates: [] }),
      setDigestModel: async () => { throw new Error('The draft fixture does not save a utility model') },
      progressForUser: async () => { throw new Error('The draft fixture does not read project journals') },
      generateNow: async () => { throw new Error('The draft fixture does not generate project journals') },
    }
    installAdminComputerFixture(deps)
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const proxy = createProxyHandlers(deps)
    cleanup.push(() => { proxy.close() })
    const handler = createAdminApiHandler(deps)
    const writes: string[] = []
    const server = createGatewayServer(deps, { ...proxy, adminRoot: resolve('gateway/public/admin'),
      admin: async (request, response, user, path, body) => {
        if (path.startsWith('/admin/api/model') && request.method !== 'GET') writes.push(path)
        return handler(request, response, user, path, body)
      } })
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else done() })
    }))
    await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cfg.publicOrigins.push(origin)
    const browser = await chromium.launch()
    cleanup.push(() => browser.close())
    const mobile = variant === 'mobile-dark'
    const context = await browser.newContext({ locale: 'zh-CN',
      viewport: mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 },
      colorScheme: mobile ? 'dark' : 'light', hasTouch: mobile, isMobile: mobile })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    const login = await context.request.post(`${origin}/login`, { form: { username: 'admin', password: 'fixture-password' },
      headers: { origin }, maxRedirects: 0 })
    expect(login.status()).toBe(302)
    await page.goto(`${origin}/admin/models`)
    await page.getByRole('button', { name: '添加组织 Provider', exact: true }).click()
    const route = page.getByRole('textbox', { name: 'Provider ID', exact: true })
    await route.fill('org-draft-fixture')
    await page.getByRole('textbox', { name: '显示名称', exact: true }).fill('待保存组织连接')
    const endpoint = page.getByRole('textbox', { name: 'API 地址', exact: true })
    await endpoint.fill('https://draft.example.invalid/v1')
    const credential = page.locator('input[type=password][aria-label="API 密钥"]')
    await credential.fill('fixture-only-key')
    const form = await page.locator('main').ariaSnapshot()
    await page.getByRole('button', { name: '组织模型', exact: true }).click()
    expect(await page.getByRole('dialog', { name: '保留当前编辑', exact: true }).count()).toBe(0)
    let guardSnapshot = ''
    for (const destination of ['权限与计价', '个人登记']) {
      const button = page.getByRole('button', { name: destination, exact: true })
      if (mobile) await button.tap()
      else await button.click()
      const guard = page.getByRole('dialog', { name: '保留当前编辑', exact: true })
      await guard.waitFor({ timeout: 10_000 })
      expect(await page.getByRole('button', { name: '组织模型', exact: true }).getAttribute('aria-pressed')).toBe('true')
      expect(await route.inputValue()).toBe('org-draft-fixture')
      expect(await endpoint.inputValue()).toBe('https://draft.example.invalid/v1')
      expect(await credential.inputValue()).toBe('fixture-only-key')
      guardSnapshot = await guard.ariaSnapshot()
      if (destination === '权限与计价') {
        await page.keyboard.press('Escape')
        await guard.waitFor({ state: 'hidden' })
      } else await guard.getByRole('button', { name: '留在当前页面', exact: true }).click()
    }
    const other = await context.newPage()
    await other.goto(`${origin}/admin/models`)
    await other.getByRole('button', { name: '添加组织 Provider', exact: true }).waitFor()
    expect(await other.getByRole('textbox', { name: 'Provider ID', exact: true }).count()).toBe(0)
    expect(await route.inputValue()).toBe('org-draft-fixture')
    expect(await credential.inputValue()).toBe('fixture-only-key')
    await other.close()
    if (webSnapshotMode() === 'refresh') await mkdir(EXPECTED, { recursive: true })
    await compareOrRefreshGolden(join(EXPECTED, `${variant}.expected.md`), `${form}\n\n${guardSnapshot}`, webSnapshotMode())
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '权限与计价', exact: true }).click()
    expect(await page.getByRole('button', { name: '权限与计价', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('dialog', { name: '保留当前编辑', exact: true }).count()).toBe(0)
    expect(writes).toEqual([])
    expect(errors).toEqual([])
  } finally {
    const failures: unknown[] = []
    for (const release of cleanup.reverse()) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Admin model draft fixture cleanup failed')
  }
})
