/** Index sources persisted through the profile's Loader and Settings services. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import PluginMarket from '../src/index.ts'

/** The `pluginManager` reads the market makes, with an empty profile. */
class StubPluginManager extends Service {
  constructor(ctx: Context) { super(ctx, 'pluginManager') }
  listBundles() { return Promise.resolve([]) }
  listVersionExemptions() { return { exemptions: {}, warnings: [] } }
}

it('saves index sources without remounting, announces them, and restores them at restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-market-configuration-')))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    // dshHome pins the provider's settings.yaml into the temporary home; watch stays off so no
    // filesystem observer outlives the test on shared CI hosts.
    writeFileSync(join(bundle, 'cordis.patch.yml'), `- insert:
    - id: settings
      name: cordis:settings
      config:
        dshHome: ${JSON.stringify(home)}
        watch: false
    - id: plugin-manager
      name: cordis:manager
    - id: plugin-market
      name: cordis:market
      config:
        indexes:
          - https://first.example/index.json
`)
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { settings: FileSettingsProvider, manager: StubPluginManager, market: PluginMarket })
    })
    ctx = await start()
    const market = ctx.get('pluginMarket')!
    expect(market.listIndexes()).toEqual([{ url: 'https://first.example/index.json' }])
    const fiberOf = (): unknown => [...ctx!.loader.entries()].find(entry => entry.options.id === 'plugin-market')?.fiber
    const fiber = fiberOf()
    let changes = 0
    ctx.on('plugin-market/changed', () => { changes++ })
    await market.setIndexes(['https://second.example/index.json ', 'http://127.0.0.1:8080/index.json'])
    expect(market.listIndexes().map(index => index.url)).toEqual(['https://second.example/index.json', 'http://127.0.0.1:8080/index.json'])
    expect(fiberOf() === fiber).toBe(true)
    expect(changes).toBe(1)
    const saved = readFileSync(join(home, 'settings.yaml'), 'utf8')
    expect(saved).toContain('plugin-market')
    expect(saved).toContain('https://second.example/index.json')
    await ctx.fiber.dispose()
    ctx = await start()
    expect(ctx.get('pluginMarket')!.listIndexes().map(index => index.url)).toEqual(['https://second.example/index.json', 'http://127.0.0.1:8080/index.json'])
  } finally {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})
