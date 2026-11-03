/** Gateway database changes reach the live Loader policy consumer and default selection. */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it, vi } from 'vitest'
import { scheduleModelGovernanceRefresh, writeModelGovernanceFile } from '../src/apply-model-governance.ts'
import { openDb } from '../src/db.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import type { GatewayModelGovernanceService } from '../src/services.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'
import { UserService } from '../src/users.ts'
import { testConfig } from './test-config.ts'

const configPath = fileURLToPath(new URL('../../examples/headless-agent/model-policy.cordis.snapshot.yml', import.meta.url))
const driver = fileURLToPath(new URL('../../examples/headless-agent/tests/fixtures/model-policy-driver.ts', import.meta.url))
const model = new URL('../../examples/headless-agent/tests/fixtures/model-policy-model.ts', import.meta.url).href
const expected = fileURLToPath(new URL('./snapshots/model-policy/live-revocation.expected.jsonl', import.meta.url))
const modules = fileURLToPath(new URL('../../examples/node_modules', import.meta.url))
const sourcePlugin = new URL('../../plugins/dsh-model-governance/src/index.ts', import.meta.url).href
const libPlugin = fileURLToPath(new URL('../../plugins/dsh-model-governance/lib', import.meta.url))
const runtimePeers = {
  'dsh-execution-authority': new URL('../../packages/context/execution-authority', import.meta.url),
  'dsh-model-provider-config': new URL('../../packages/llm/model-provider-config', import.meta.url),
  'dsh-llm': new URL('../../packages/llm/llm', import.meta.url),
}

it.each([
  { patch: '[]\n', revocation: 'model-access' },
  { patch: '[{ id: agent-default-model, config: { provider: old, model: old } }]\n', revocation: 'model-access' },
  { patch: '---\n[]\n...\n', revocation: 'model-access' },
  { patch: '[]\n', revocation: 'role' },
])(
  'loads the projected default and revokes a live route after overlapping refreshes from %j', async ({ patch, revocation }) => {
    const root = await mkdtemp(join(tmpdir(), 'model-policy-snapshot-'))
    const db = openDb(join(root, 'gateway.sqlite'))
    const cfg = testConfig(root)
    const users = new UserService(db, cfg)
    const governance: GatewayModelGovernanceService = new ModelGovernanceService(db, 'UTC')
    const usage = createUsageIntakeServer(governance)
    let releaseHeld!: () => void
    const held = new Promise<void>((resolve) => { releaseHeld = resolve })
    let readHeld = false
    let refreshWrites = 0
    let firstId: number
    const home = join(cfg.usersRoot, 'first', 'dsh')
    const policyPath = join(home, 'model-governance.json')
    const control = createServer((_request, response) => {
      void (async () => {
        scheduleModelGovernanceRefresh(deps)
        await vi.waitFor(() => { expect(readHeld).toBe(true) }, { timeout: 5_000 })
        if (revocation === 'role') await users.setRole(firstId, 'user')
        else await governance.setUserAccess(firstId, 'p', 'm', false)
        scheduleModelGovernanceRefresh(deps)
        releaseHeld()
        await vi.waitFor(() => {
          const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { models: { allowed: boolean }[] }
          expect(policy.models[0]?.allowed).toBe(false)
          expect(refreshWrites).toBe(4)
        }, { timeout: 5_000 })
        response.end('updated')
      })().catch((error: unknown) => { response.writeHead(500); response.end(String(error)) })
    })
    const deps = { cfg, users, governance, projects: { list: async () => [] } }
    try {
      const first = await users.create({ username: 'first', password: 'fixture-password', role: revocation === 'role' ? 'admin' : 'user' })
      firstId = first.id
      const second = await users.create({ username: 'second', password: 'fixture-password', role: revocation === 'role' ? 'admin' : 'user' })
      await new Promise<void>(resolve => usage.listen(0, '127.0.0.1', resolve))
      cfg.intakePort = (usage.address() as AddressInfo).port
      await governance.upsertModel({ provider: 'p', model: 'm', displayName: 'Fixture', enabled: true,
        adminAllowed: true, userAllowed: revocation !== 'role', inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
      await writeFile(join(home, 'cordis.patch.yml'), patch)
      await writeModelGovernanceFile(cfg, governance, first)
      const readPolicy = governance.policyFor.bind(governance)
      governance.policyFor = async (user) => {
        if (user.id === second.id) { readHeld = true; await held }
        return readPolicy(user)
      }
      governance.projectionWrite = async (operation) => {
        const result = await operation()
        refreshWrites++
        return result
      }
      await new Promise<void>(resolve => control.listen(0, '127.0.0.1', resolve))
      const result = await runLoaderSmoke({
        label: 'live model policy snapshot', tempDirPrefix: 'model-policy-runtime-',
        binScript: driver, libBinScript: driver, configPath, binArgs: ['./cordis.yml'],
        tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), sourceImport: 'tsx/esm',
        env: { DSH_HOME: home, DSH_MODEL_GOVERNANCE: policyPath, DSH_POLICY_FIXTURE_CONTROL: `http://127.0.0.1:${String((control.address() as AddressInfo).port)}` },
        prepare: async (cwd) => {
          let plugin = sourcePlugin
          if (resolveExampleMode() === 'lib') {
            const installed = join(cwd, 'policy-plugin')
            await cp(libPlugin, installed, { recursive: true })
            await writeFile(join(installed, 'package.json'), '{"type":"module"}\n')
            const peers = join(installed, 'node_modules', '@deepseek-ai')
            await mkdir(peers, { recursive: true })
            for (const [name, url] of Object.entries(runtimePeers)) {
              await symlink(fileURLToPath(url), join(peers, name), process.platform === 'win32' ? 'junction' : 'dir')
            }
            plugin = pathToFileURL(join(installed, 'index.js')).href
          }
          const config = (await readFile(configPath, 'utf8'))
            .replace('./tests/fixtures/model-policy-model.ts', model)
            .replace('../../plugins/dsh-model-governance/src/index.ts', plugin)
          await writeFile(join(cwd, 'cordis.yml'), config)
          await symlink(modules, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
        },
      })
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(await readFile(expected, 'utf8'))
    } finally {
      releaseHeld()
      if (control.listening) await new Promise<void>((resolve, reject) => control.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      if (usage.listening) await new Promise<void>((resolve, reject) => usage.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS,
)
