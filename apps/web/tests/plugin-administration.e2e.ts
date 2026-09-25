/** Assembled acceptance using the built CLI profile, real pnpm and actual Admin HTTP routes. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, webSnapshotMode } from './golden.ts'
import { fileURLToPath } from 'node:url'

const DIRECTORY = fileURLToPath(new URL('./snapshots/plugin-administration', import.meta.url))
import { loadConfig } from '../../../gateway/src/config.ts'
import { openDb } from '../../../gateway/src/db.ts'
import { AuthService } from '../../../gateway/src/auth.ts'
import { UserService } from '../../../gateway/src/users.ts'
import { ProjectService } from '../../../gateway/src/projects.ts'
import { AuditService } from '../../../gateway/src/audit.ts'
import { InstanceManager } from '../../../gateway/src/instances.ts'
import { GatewayPrincipalSigner } from '../../../gateway/src/principal.ts'
import { GatewayPluginManagement } from '../../../gateway/src/plugin-management.ts'
import { createGatewayServer, type GatewayDeps } from '../../../gateway/src/server.ts'
import { createAdminApiHandler } from '../../../gateway/src/admin-api.ts'

it('installs a local bundle through the built Admin workflow and verifies the real profile files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-admin-browser-'))
  const cleanup: Array<() => unknown> = [() => rm(root, { recursive: true, force: true })]
  try {
    const bundle = join(root, 'bundle'), home = join(root, 'home')
    await mkdir(bundle)
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@fixture/admin-install', version: '1.0.0', description: 'Administrative installation acceptance', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
    const process = spawn(globalThis.process.execPath, [resolve('apps/cli/lib/bin.js'), '--profile', 'web', '--port', '0', '--no-open'], {
      cwd: root, env: { ...globalThis.process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls' }, stdio: ['ignore', 'pipe', 'pipe'],
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
    const db = openDb(join(root, 'gateway.sqlite')); cleanup.push(() => { db.close() })
    const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_UPSTREAM_TIMEOUT_MS: '120000' })
    const instances = new InstanceManager(db, cfg)
    instances.isLive = async () => true; instances.generationOf = async () => 1
    instances.portOf = async () => Number(new URL(runtime).port)
    let leases = 0
    instances.operationRef = async (_target, delta, generation) => { expect(generation).toBe(1); leases += delta }
    const deps: GatewayDeps = { cfg, instances, auth: new AuthService(db, cfg),
      users: new UserService(db, cfg), projects: new ProjectService(db, cfg), audit: new AuditService(db) }
    const admin = await deps.users.create({ username: 'admin', password: 'fixture-password', role: 'admin' })
    await deps.users.changeOwnPassword(admin.id, 'fixture-password')
    deps.pluginManagement = new GatewayPluginManagement(deps, new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'fixture', 30000), 'fixture-node')
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), adminRoot: resolve('gateway/public/admin') })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error) reject(error); else resolve() })
    }))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; cfg.publicOrigins.push(base)
    const browser = await chromium.launch(); cleanup.push(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    const login = await page.request.post(`${base}/login`, { form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0 }); expect(login.status()).toBe(302)
    try {
      await page.goto(`${base}/admin/plugins`)
      await page.getByLabel('插件运行范围').selectOption(`user:${admin.id}`)
      await page.getByRole('button', { name: '查看 subagent', exact: true }).click()
      const config = page.getByRole('region', { name: 'subagent 配置', exact: true })
      await config.getByLabel('maxDepth', { exact: true }).fill('2')
      await config.getByRole('button', { name: '保存配置', exact: true }).click()
      await config.getByText('即时配置已保存。', { exact: true }).waitFor()
      const settings = async () => parseYaml(await readFile(join(home, 'settings.yaml'), 'utf8')) as { subagent: { maxDepth: number } }
      expect((await settings()).subagent.maxDepth).toBe(2)
      await compareOrRefreshGolden(join(DIRECTORY, 'configuration.expected.md'), await config.ariaSnapshot(), webSnapshotMode())
      await config.getByLabel('maxDepth', { exact: true }).fill('4')
      const describe = await page.request.post(`${base}/admin/api/plugins/invoke`, { headers: { origin: base }, data: {
        nodeId: 'fixture-node', target: { kind: 'user', id: admin.id }, generation: 1, rpcId: randomUUID(), endpoint: 'settings.describe', args: {},
      } })
      expect(describe.status()).toBe(200)
      const described = await describe.json() as { result: { ok: boolean; value: { namespaces: Array<{ ns: string; revision: number }> } } }
      expect(described.result.ok).toBe(true)
      const revision = described.result.value.namespaces.find(item => item.ns === 'subagent')!.revision
      const concurrent = await page.request.post(`${base}/admin/api/plugins/invoke`, { headers: { origin: base }, data: {
        nodeId: 'fixture-node', target: { kind: 'user', id: admin.id }, generation: 1, rpcId: randomUUID(), endpoint: 'settings.mutate',
        args: { ns: 'subagent', expectedRevision: revision, ops: [{ op: 'set', path: ['maxDepth'], value: 3 }] },
      } })
      expect((await concurrent.json() as { result: { ok: boolean } }).result.ok).toBe(true)
      await config.getByRole('button', { name: '保存配置', exact: true }).click()
      await config.getByText('配置已在其他位置更新。请放弃草稿、核对新值后重新编辑。', { exact: true }).waitFor()
      expect((await settings()).subagent.maxDepth).toBe(3)
      await config.getByRole('button', { name: '放弃草稿', exact: true }).click()
      expect(await config.getByLabel('maxDepth', { exact: true }).inputValue()).toBe('3')
      await page.getByRole('button', { name: '返回插件列表', exact: true }).click()
      await page.getByRole('button', { name: '添加插件', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('input').fill(bundle)
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      await page.getByRole('button', { name: '立即启用', exact: true }).waitFor({ timeout: 60000 })
      const manifest = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dependencies['@fixture/admin-install']).toBeTruthy()
      expect(manifest.dsh.profile.bundles).not.toContain('@fixture/admin-install')
      const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: '查看 admin-install', exact: true }) })
      await compareOrRefreshGolden(join(DIRECTORY, 'install.expected.md'), await row.ariaSnapshot(), webSnapshotMode())
      await page.getByRole('button', { name: '立即启用', exact: true }).click()
      await expect.poll(async () => (JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8')) as typeof manifest).dsh.profile.bundles).toContain('@fixture/admin-install')
      expect(errors).toEqual([])
      await expect.poll(() => leases).toBe(0)
    } catch (error) {
      await page.screenshot({ path: '.artifacts/plugin-admin-failure.png', fullPage: true })
      await writeFile('.artifacts/plugin-admin-failure.md', await page.locator('main').ariaSnapshot() + '\n')
      await writeFile('.artifacts/plugin-admin-runtime.log', output)
      throw error
    }
  } finally {
    const failures: unknown[] = []
    for (const dispose of cleanup.reverse()) { try { await dispose() } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, 'plugin admin cleanup failed')
  }
}, 150000)

it('owns regional plugin installation and configuration goldens', async () => { expect((await readdir(DIRECTORY)).sort()).toEqual(['configuration.expected.md', 'install.expected.md']) })
