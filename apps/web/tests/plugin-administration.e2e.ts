/** Assembled acceptance using the built CLI profile, real pnpm and actual Admin HTTP routes. */
import { responsiveBrowser, responsiveMobileEmulation } from './responsive-browser.ts'
import { auditAdminState } from './admin-responsive-state.ts'
import type { Locator, Route } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { expect, it } from 'vitest'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'
import { fileURLToPath } from 'node:url'

const DIRECTORY = fileURLToPath(new URL('./snapshots/plugin-administration', import.meta.url))
const matrix = process.env.DSH_FEATURE_MATRIX === '1'
import { loadConfig } from '../../../gateway/src/config.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../../../gateway/src/principal.ts'
import { GatewayPluginManagement } from '../../../gateway/src/plugin-management.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'
import { RuntimeCatalogError, type RuntimeCatalogEntry, type RuntimeId, type RuntimeNodeId } from '../../../gateway/src/runtime-catalog.ts'

it('installs a local bundle through the built Admin workflow and verifies the real profile files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-admin-browser-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const bundle = join(root, 'bundle'), home = join(root, 'users/admin/dsh')
    await mkdir(bundle)
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@fixture/admin-install', version: '1.0.0', description: 'Administrative installation acceptance', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
    const pair = generateKeyPairSync('ed25519')
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => { db.close() })
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_UPSTREAM_TIMEOUT_MS: '120000' })
    const instances = new InstanceManager(db, cfg)
    instances.isLive = async () => true; instances.generationOf = async () => 1
    // The runtime port is bound by the spawned CLI below; reads happen only after it reports its address.
    let runtimePort = 0
    instances.portOf = async () => runtimePort
    let leases = 0
    instances.operationRef = async (_target, delta, generation) => { expect(generation).toBe(1); leases += delta }
    const deps: GatewayDeps = { cfg, instances, auth: new AuthService(db, cfg),
      users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db) }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    const runtimeId = randomUUID() as RuntimeId, nodeId = randomUUID() as RuntimeNodeId
    const environment: RuntimeCatalogEntry = { id: runtimeId, owner: { kind: 'personal', id: admin.id, name: admin.displayName },
      node: { id: nodeId, name: 'Plugin fixture computer', status: 'active', lastHeartbeatAt: null },
      routing: 'local', observedState: 'ready', generation: 1 }
    const resolveEnvironment = async (_actor: unknown, id: string) => {
      if (id !== runtimeId) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      return environment
    }
    // This fixture owns one externally launched process; its SQLite owner row and allocation name refer to that process.
    instances.resolveTarget = async (target) => {
      if (typeof target === 'number') target = { kind: 'user', id: target }
      if (target.kind !== 'user' || target.id !== admin.id || target.runtimeId !== undefined && target.runtimeId !== runtimeId) {
        throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      }
      return { ...target, runtimeId }
    }
    deps.runtimeCatalog = {
      pageForAccount: async () => ({ items: [environment], nextCursor: null }),
      pageForAdministrator: async () => ({ items: [environment], nextCursor: null }),
      pageForAdministratorOwner: async (_actor, owner) => ({ items: owner.kind === 'personal' && owner.id === admin.id ? [environment] : [], nextCursor: null }),
      resolveForAccount: resolveEnvironment, resolveForAdministrator: resolveEnvironment,
    }
    const unsupportedAllocation = async (): Promise<never> => { throw new Error('Allocation mutations are outside the plugin fixture') }
    deps.runtimeManagement = { policy: unsupportedAllocation, setPolicy: unsupportedAllocation, allocate: unsupportedAllocation,
      allocationReceipt: unsupportedAllocation, retire: unsupportedAllocation }
    deps.nodeServiceIdentity = { nodeId, organizationId: 'fixture', authorize: async () => { throw new Error('The plugin fixture has no node bridge') } }
    deps.pluginManagement = new GatewayPluginManagement(deps, new GatewayPrincipalSigner(pair.privateKey, 'fixture', 30000), nodeId)
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), adminRoot: resolve(globalThis.process.env.DSH_ADMIN_ASSET_ROOT ?? 'gateway/public/admin') })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else resolve() })
    }))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; cfg.publicOrigins.push(base)
    // Managed runtimes authenticate admin traffic by a verified principal against the credential
    // injected at launch; the fixture reproduces that launch contract with a patch overlay and a
    // credential file naming this test's signer public key and runtime identity.
    const overlay = join(root, 'gateway-runtime.patch.yml')
    await writeFile(overlay, "- insert:\n    - id: gateway-runtime\n      name: '@deepseek-ai/dsh-gateway-runtime'\n")
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'directory-grants.json'), JSON.stringify([{ path: workspace, mode: 'rw' }]))
    const credential = join(root, 'gateway-credential.json')
    await writeFile(credential, JSON.stringify({
      version: 1, gatewayUrl: base, organization: 'fixture', token: 'fixture-runtime-token',
      principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      runtime: { kind: 'user', id: admin.id, runtimeId, generation: 1 },
    }))
    const process = spawn(globalThis.process.execPath, [resolve('apps/cli/lib/bin.js'), '--profile', 'web', '--patch', overlay, '--port', '0', '--no-open'], {
      cwd: root, env: { ...globalThis.process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls', DSH_GATEWAY_CREDENTIAL_FILE: credential }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const exited = new Promise<void>((resolve, reject) => { process.once('close', () => { resolve() }); process.once('error', reject) })
    cleanup.push(async () => { if (process.exitCode === null) process.kill('SIGTERM'); await exited })
    for (const stream of [process.stdout, process.stderr]) stream.on('data', (chunk) => { output = (output + String(chunk)).slice(-32000) })
    await expect.poll(() => {
      if (process.exitCode !== null) throw new Error(output)
      return /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    }, { timeout: 60000 }).toBeTruthy()
    const runtime = /dsh web: (http:\/\/\S+)/u.exec(output)?.[1]
    if (runtime === undefined) throw new Error('CLI did not report its Web address')
    runtimePort = Number(new URL(runtime).port)
    const assertion = new GatewayPrincipalSigner(pair.privateKey, 'fixture', 30000).issuePluginManagement({
      user: admin, runtime: { kind: 'user', id: admin.id, runtimeId, generation: 1 }, scope: { kind: 'personal' },
    }, 120000)
    const rpcId = randomUUID(), endpoint = 'pluginManager/catalog'
    const catalog = await fetch(`http://127.0.0.1:${runtimePort}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', [PRINCIPAL_HEADER]: assertion },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: {} } }),
    })
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toMatchObject({
      rpcId, result: { ok: true, value: { managementAvailable: true, manage: true } },
    })
    const browser = await responsiveBrowser.launch(); cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 },
      ...(matrix ? { hasTouch: true, isMobile: responsiveMobileEmulation, reducedMotion: 'reduce' as const } : {}) })
    const activate = async (control: Locator) => { if (matrix) await control.tap(); else await control.click() }
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const login = await page.request.post(`${base}/login`, { form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0 }); expect(login.status()).toBe(302)
    try {
      await page.goto(`${base}/admin/plugins`)
      await page.getByLabel('插件管理对象').selectOption(`user:${admin.id}`)
      await page.getByRole('button', { name: '查看 子智能体', exact: true }).waitFor()
      await auditAdminState(page, 'plugins-runtime-catalog', page.locator('main'))
      await activate(page.getByRole('button', { name: '查看 子智能体', exact: true }))
      const config = page.getByRole('region', { name: 'subagent 配置', exact: true })
      await auditAdminState(page, 'plugins-configuration-loaded', config)
      await config.getByLabel('maxDepth', { exact: true }).fill('2')
      await auditAdminState(page, 'plugins-configuration-draft', config)
      await activate(config.getByRole('button', { name: '保存配置', exact: true }))
      await config.getByText('配置已保存并即时生效。', { exact: true }).waitFor()
      const settings = async () => parseYaml(await readFile(join(home, 'settings.yaml'), 'utf8')) as { subagent: { maxDepth: number } }
      expect((await settings()).subagent.maxDepth).toBe(2)
      if (!matrix) await compareOrRefreshGolden(join(DIRECTORY, 'configuration.expected.md'), await config.ariaSnapshot(), webSnapshotMode())
      await auditAdminState(page, 'plugins-configuration-saved', config)
      await config.getByLabel('maxDepth', { exact: true }).fill('4')
      const describe = await page.request.post(`${base}/admin/api/plugins/invoke`, { headers: { origin: base }, data: {
        nodeId, target: { kind: 'user', id: admin.id, runtimeId }, generation: 1, rpcId: randomUUID(), endpoint: 'settings.describe', args: {},
      } })
      expect(describe.status()).toBe(200)
      const described = await describe.json() as { result: { ok: boolean; value: { namespaces: Array<{ ns: string; revision: number }> } } }
      expect(described.result.ok).toBe(true)
      const revision = described.result.value.namespaces.find(item => item.ns === 'subagent')!.revision
      const concurrent = await page.request.post(`${base}/admin/api/plugins/invoke`, { headers: { origin: base }, data: {
        nodeId, target: { kind: 'user', id: admin.id, runtimeId }, generation: 1, rpcId: randomUUID(), endpoint: 'settings.mutate',
        args: { ns: 'subagent', expectedRevision: revision, ops: [{ op: 'set', path: ['maxDepth'], value: 3 }] },
      } })
      expect((await concurrent.json() as { result: { ok: boolean } }).result.ok).toBe(true)
      await activate(config.getByRole('button', { name: '保存配置', exact: true }))
      await config.getByText('配置已在其他位置更新。请放弃草稿、核对新值后重新编辑。', { exact: true }).waitFor()
      expect((await settings()).subagent.maxDepth).toBe(3)
      await auditAdminState(page, 'plugins-configuration-conflict', config)
      await activate(config.getByRole('button', { name: '放弃草稿', exact: true }))
      expect(await config.getByLabel('maxDepth', { exact: true }).inputValue()).toBe('3')
      await auditAdminState(page, 'plugins-configuration-discarded', config)
      await activate(page.getByRole('button', { name: '返回插件列表', exact: true }))
      await activate(page.getByRole('button', { name: '添加插件', exact: true }))
      const dialog = page.getByRole('dialog')
      await auditAdminState(page, 'plugins-install-blank', dialog)
      await activate(dialog.getByRole('button', { name: '插件安装引导和示例', exact: true }))
      await auditAdminState(page, 'plugins-install-guide', dialog)
      await activate(dialog.getByRole('button', { name: '收起引导', exact: true }))
      await activate(dialog.getByRole('button', { name: /^安装源/ }))
      const registry = page.getByRole('group', { name: '从哪个 npm 源下载插件', exact: true })
      await registry.waitFor()
      await auditAdminState(page, 'plugins-install-registry', registry)
      await registry.getByRole('textbox', { name: '自定义地址', exact: true }).fill('https://registry.example.invalid/')
      await auditAdminState(page, 'plugins-install-registry-custom', registry)
      // pnpm's own registry joins the offered list only when it differs from the first offered one;
      // a mirror-configured host collapses the official option, so check whichever registry leads.
      await registry.getByRole('radio').first().check()
      await activate(dialog.getByRole('button', { name: /^安装源/ }))
      await dialog.getByRole('textbox', { name: '包名或地址', exact: true }).fill(bundle)
      await auditAdminState(page, 'plugins-install-path', dialog)
      await activate(dialog.getByRole('button', { name: '安装', exact: true }))
      await page.getByRole('button', { name: '立即启用', exact: true }).waitFor({ timeout: 60000 })
      const manifest = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dependencies['@fixture/admin-install']).toBeTruthy()
      expect(manifest.dsh.profile.bundles).not.toContain('@fixture/admin-install')
      await auditAdminState(page, 'plugins-installed-disabled', dialog)
      await activate(dialog.getByRole('button', { name: '查看安装详情', exact: true }))
      await auditAdminState(page, 'plugins-install-output', dialog)
      const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: '查看 @fixture/admin-install', exact: true }) })
      if (!matrix) await compareOrRefreshGolden(join(DIRECTORY, 'install.expected.md'), await row.ariaSnapshot(), webSnapshotMode())
      await activate(page.getByRole('button', { name: '立即启用', exact: true }))
      await expect.poll(async () => (JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as typeof manifest).dsh.profile.bundles).toContain('@fixture/admin-install')
      await auditAdminState(page, 'plugins-enabled', row)
      await activate(page.getByRole('button', { name: '查看 @fixture/admin-install', exact: true }))
      await auditAdminState(page, 'plugins-installed-details', page.locator('main'))
      await activate(page.getByRole('button', { name: '卸载 @fixture/admin-install', exact: true }))
      await auditAdminState(page, 'plugins-uninstall-confirm', dialog)
      await activate(dialog.getByRole('button', { name: '取消', exact: true }))
      expect((JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as typeof manifest)
        .dependencies['@fixture/admin-install']).toBeTruthy()
      let removalArrived = false
      let releaseRemoval!: () => void
      const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve })
      const refuseRemoval = async (route: Route) => {
        const input = route.request().postDataJSON() as { endpoint: string; rpcId: string }
        if (input.endpoint !== 'pluginManager/removeBundle') { await route.fallback(); return }
        removalArrived = true
        await removalHeld
        await route.fulfill({ json: { rpcId: input.rpcId, result: { ok: false,
          error: { code: 'qa-refusal', message: 'QA package is retained' } } } })
      }
      await page.route('**/admin/api/plugins/invoke', refuseRemoval)
      try {
        await activate(page.getByRole('button', { name: '卸载 @fixture/admin-install', exact: true }))
        await activate(dialog.getByRole('button', { name: '卸载', exact: true }))
        await expect.poll(() => removalArrived, { timeout: 10_000 }).toBe(true)
        await auditAdminState(page, 'plugins-uninstall-pending', page.locator('main'))
        releaseRemoval()
        await page.getByText(/QA package is retained/).waitFor()
        await auditAdminState(page, 'plugins-uninstall-refused', page.locator('main'))
      } finally {
        releaseRemoval()
        await page.unroute('**/admin/api/plugins/invoke', refuseRemoval)
      }
      await activate(page.getByRole('button', { name: '卸载 @fixture/admin-install', exact: true }))
      await activate(dialog.getByRole('button', { name: '卸载', exact: true }))
      // pnpm drops the whole dependencies object once its last entry is gone.
      await expect.poll(async () => (JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as { dependencies?: Record<string, string> })
        .dependencies?.['@fixture/admin-install'], { timeout: 60000 }).toBeUndefined()
      await page.getByRole('button', { name: '查看 @fixture/admin-install', exact: true }).waitFor({ state: 'hidden' })
      await auditAdminState(page, 'plugins-uninstalled', page.locator('main'))
      expect(errors).toEqual([])
      await expect.poll(() => leases).toBe(0)
    } catch (error) {
      await page.screenshot({ path: '.artifacts/plugin-admin-failure.png' })
      await writeFile('.artifacts/plugin-admin-failure.md', await page.locator('main').ariaSnapshot() + '\n')
      await writeFile('.artifacts/plugin-admin-runtime.log', output)
      throw error
    }
  } finally {
    const failures: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'plugin admin cleanup failed')
  }
}, matrix ? 1_800_000 : 150000)

it('owns regional plugin installation and configuration goldens', async () => { expect((await readdir(DIRECTORY)).sort()).toEqual(['configuration.expected.md', 'install.expected.md']) })
