import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Built-artifact smoke for the first generated Remote: plain Node boots the
 * Host and Browser bundle handoffs, then crosses the shared `/api` HTTP route.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

const requiredArtifacts = [
  'packages/client/connection/lib/client.js',
  'packages/client/connection/lib/index.js',
  'packages/api/remotes/lib/client.js',
  'packages/boot/plugin-manager/lib/index.js',
  'packages/boot/plugin-manager/lib/typert.host.js',
  'packages/core/agent/lib/index.js',
  'packages/core/session/lib/index.js',
  'packages/goal/goal/lib/index.js',
  'packages/goal/goal/lib/typert.host.js',
  'packages/api/gateway/lib/client.js',
  'packages/api/gateway/lib/index.js',
  'packages/typert/registry/lib/client.js',
  'packages/typert/registry/lib/index.js',
].every(path => existsSync(artifact(path)))

describe.skipIf(!requiredArtifacts)('Goal Remote built LIB chain', () => {
  it('runs root and Agent-scoped calls through generated bundles and real HTTP', async () => {
    const urls = Object.fromEntries(Object.entries({
      manager: 'packages/boot/plugin-manager/lib/index.js',
      managerTypert: 'packages/boot/plugin-manager/lib/typert.host.js',
      agent: 'packages/core/agent/lib/index.js',
      apiGatewayClient: 'packages/api/gateway/lib/client.js',
      apiGatewayHost: 'packages/api/gateway/lib/index.js',
      connectionClient: 'packages/client/connection/lib/client.js',
      connectionHost: 'packages/client/connection/lib/index.js',
      goal: 'packages/goal/goal/lib/index.js',
      goalTypert: 'packages/goal/goal/lib/typert.host.js',
      registryClient: 'packages/typert/registry/lib/client.js',
      registryHost: 'packages/typert/registry/lib/index.js',
      remotesClient: 'packages/api/remotes/lib/client.js',
      session: 'packages/core/session/lib/index.js',
    }).map(([key, path]) => [key, artifactUrl(path)]))
    const script = `
      import { createServer } from 'node:http'
      import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      import * as cordis from '@deepseek-ai/cordis'

      const urls = ${JSON.stringify(urls)}
      const { Context } = cordis
      const { default: AgentRegistry } = await import(urls.agent)
      const connectionHost = await import(urls.connectionHost)
      const { default: TypertRemoteService } = await import(urls.apiGatewayHost)
      const { default: GoalService } = await import(urls.goal)
      const { TYPERT } = await import(urls.goalTypert)
      const { default: TypertRegistry } = await import(urls.registryHost)
      const { Session, SessionId } = await import(urls.session)

      const routes = []
      const host = new Context()
      host.provide('webServer', {
        register(route) {
          routes.push(route)
          return () => { routes.splice(routes.indexOf(route), 1) }
        },
        tapIndex() { return () => {} },
        port: 0,
      })
      await host.plugin({ inject: connectionHost.inject, apply: connectionHost.apply })
      await host.plugin(TypertRegistry)
      await host.plugin(AgentRegistry)
      await host.plugin(TypertRemoteService)
      await host.plugin(GoalService)
      host.typert.register(TYPERT)
      const { default: PluginManager } = await import(urls.manager)
      const managerTypert = await import(urls.managerTypert)
      const profileDir = mkdtempSync(join(tmpdir(), 'built-manager-'))
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'test-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }))
      host.provide('loader', { entries: () => [] })
      host.provide('profileContext', { name: 'test-profile', dir: profileDir, installAnchor: join(profileDir, 'package.json') })
      const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol')
      let administrator = false
      const stopPolicy = host.provide('pluginManagementAuthorization', {
        protectedModules: new Set(),
        async authorize() { if (!administrator) throw new RemoteError('plugin-management/forbidden', 'administrator required', {}) },
      })
      await host.plugin(PluginManager, { authorization: 'required' })
      host.typert.register(managerTypert.TYPERT)

      const makeAgent = rawId => {
        const session = new Session(SessionId(rawId))
        return {
          id: session.id,
          options: {},
          session,
          ctx: host.extend(),
          status: 'idle',
          acceptsNextStep: false,
          send() {},
          updateInbox() { return 'not-found' },
          followup() {},
          steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } },
          inject(input) { session.append('user/message', input, { surfaceOp: 'append' }) },
          reserveTurnAdmission() {},
          cancel() {},
          whenIdle() { return Promise.resolve() },
        }
      }
      const rootAgent = makeAgent('built-root-agent')
      const scopedAgent = makeAgent('built-scoped-agent')
      await host.agents.register(rootAgent)
      await host.agents.register(scopedAgent)

      if (routes.length !== 1 || routes[0].path !== '/api') {
        throw new Error('Connection did not register exactly one /api route')
      }
      const server = createServer((request, response) => { void routes[0].handler(request, response) })
      await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP server has no TCP address')
      const origin = 'http://127.0.0.1:' + String(address.port)

      const handoffs = new Map()
      globalThis.window = {
        __ModuleLoader__: {
          load(handoff) { handoffs.set(handoff.id, handoff) },
        },
      }
      globalThis.location = { hostname: '127.0.0.1', origin, search: '' }
      await import(urls.registryClient)
      await import(urls.connectionClient)
      await import(urls.apiGatewayClient)
      await import(urls.remotesClient)

      const clientExports = new Map()
      const instantiate = id => {
        const handoff = handoffs.get(id)
        if (handoff === undefined) throw new Error('missing Client bundle handoff ' + id)
        return handoff.factory(specifier => {
          if (specifier === '@deepseek-ai/cordis') return cordis
          if (clientExports.has(specifier)) return clientExports.get(specifier)
          throw new Error('unexpected Client external ' + specifier)
        })
      }
      const client = new Context()
      for (const id of [
        '@deepseek-ai/dsh-typert-registry',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-api-gateway',
        '@deepseek-ai/dsh-api-remotes',
      ]) {
        const plugin = instantiate(id)
        clientExports.set(id + '/client', plugin)
        await client.plugin({ inject: plugin.inject, apply: plugin.apply })
      }
      client.typert.contexts.registerClient('agent', {
        identity: candidate => candidate.builtAgentId,
      })

      const managementDenied = []
      for (const call of [
        () => client.remote.pluginManager.listPlugins(), () => client.remote.pluginManager.listBundles(),
        () => client.remote.pluginManager.inspect('test-bundle'),
        () => client.remote.pluginManager.setPluginEnabled('entry', false),
        () => client.remote.pluginManager.setBundleEnabled('test-bundle', false),
        () => client.remote.pluginManager.installBundle('test-bundle'),
        () => client.remote.pluginManager.cancelInstall('request'),
        () => client.remote.pluginManager.removeBundle('test-bundle'),
      ]) managementDenied.push(await call())
      administrator = true
      const managementAllowed = await client.remote.pluginManager.listBundles()
      stopPolicy()
      const managementMissing = await client.remote.pluginManager.listBundles()
      const invalidResult = await client.remote.goals.create(rootAgent.id, { objective: 1 })
      // Every generated method resolves to the RemoteResult envelope; the
      // business values below are what the assertions pin.
      const rootResult = await client.remote.goals.create(rootAgent.id, { objective: 'root goal' })
      const rootEdit = await client.remote.goals.edit(
        rootAgent.id,
        rootResult.value.ref,
        { objective: 'edited root goal' },
      )
      const agentContext = client.extend({ builtAgentId: scopedAgent.id })
      const scopedResult = await agentContext.remote.goals.create({ objective: 'scoped goal', maxGoalRounds: 3 })
      const result = {
        managementDenied, managementAllowed, managementMissing,
        invalidResult,
        rootResult: rootResult.value,
        rootEdit: rootEdit.value,
        scopedResult: scopedResult.value,
        rootGoal: host.goals.get(rootAgent)?.objective,
        scopedGoal: host.goals.get(scopedAgent)?.objective,
        rootEvents: rootAgent.session.snapshotEvents().length,
        scopedEvents: scopedAgent.session.snapshotEvents().length,
      }

      await client.fiber.dispose()
      await new Promise((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose()
        else rejectClose(error)
      }))
      await host.fiber.dispose()
      rmSync(profileDir, { recursive: true, force: true })
      console.log(JSON.stringify(result))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      managementDenied: Array<{ ok: boolean; error?: { code: string } }>
      managementAllowed: { ok: boolean; value: unknown[] }
      managementMissing: { ok: boolean; error?: { code: string } }
      invalidResult: { ok: boolean; error?: { code: string } }
      rootResult: { ref: { id: string; revision: number } }
      rootEdit: { objective: string; revision: number }
      scopedResult: { ref: { id: string; revision: number } }
      rootGoal: string
      scopedGoal: string
      rootEvents: number
      scopedEvents: number
    }
    expect(output.managementDenied).toHaveLength(8)
    for (const result of output.managementDenied) expect(result).toMatchObject({ ok: false, error: { code: 'plugin-management/forbidden' } })
    expect(output.managementAllowed).toEqual({ ok: true, value: [] })
    expect(output.managementMissing).toMatchObject({ ok: false, error: { code: 'plugin-management/forbidden' } })
    expect(output).toMatchObject({
      invalidResult: { ok: false, error: { code: 'gateway/input-invalid' } },
      rootResult: { ref: { revision: 1 } },
      rootEdit: { objective: 'edited root goal', revision: 2 },
      scopedResult: { ref: { revision: 1 } },
      rootGoal: 'edited root goal',
      scopedGoal: 'scoped goal',
      rootEvents: 2,
      scopedEvents: 1,
    })
    expect(output.rootResult.ref.id).toMatch(/^goal-/)
    expect(output.scopedResult.ref.id).toMatch(/^goal-/)
  }, 60_000)
})

/** Execute one ESM script without tsx or a TypeScript loader. */
function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 55_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
