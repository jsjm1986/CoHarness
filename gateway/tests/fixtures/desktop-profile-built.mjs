/** Plain-Node snapshot of the shipped desktop profile entries and Gateway policy patch through the real Loader. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const artifact = resolve(process.argv[2] ?? repository)
const moduleAt = (root, relative) => import(pathToFileURL(join(root, relative)).href)
const [{ Context }, { default: Loader }, { default: Include, applyEntryPatches, entryListSchema }, { loadConfig }, { policyPatchText }] =
  await Promise.all([
    moduleAt(repository, 'vendor/cordis/lib/index.js'), moduleAt(repository, 'vendor/loader/lib/index.js'),
    moduleAt(repository, 'vendor/include/lib/index.js'), moduleAt(artifact, 'gateway/lib/config.js'),
    moduleAt(artifact, 'gateway/lib/launch-stamp.js'),
  ])
const requireInclude = createRequire(join(repository, 'vendor/include/package.json'))
const yaml = requireInclude('js-yaml')
const modules = new Map(await Promise.all([
  ['@deepseek-ai/dsh-typert-registry', repository, 'packages/typert/registry/lib/index.js'],
  ['@deepseek-ai/dsh-remote-desktop-vnc', artifact, 'packages/remote-desktop/remote-desktop-vnc/lib/index.js'],
  ['@deepseek-ai/dsh-remote-desktop-stream', artifact, 'packages/remote-desktop/remote-desktop-stream/lib/index.js'],
  ['@deepseek-ai/dsh-api-remote-desktop-controller', artifact, 'packages/api/remote-desktop-controller/lib/index.js'],
  ['@deepseek-ai/dsh-gateway-execution/desktop-availability', repository, 'packages/context/gateway-execution/lib/desktop-availability.js'],
].map(async ([name, root, file]) => [name, await moduleAt(root, file)])))
const desktopIds = new Set(['remote-desktop-vnc', 'remote-desktop-stream', 'remote-desktop-controller'])
const webPatch = yaml.load(await readFile(join(repository, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
const webEntries = applyEntryPatches([], webPatch, () => {}).filter(entry => desktopIds.has(entry.id))
assert.equal(webEntries.length, 3)
const root = await mkdtemp(join(tmpdir(), 'hgw-desktop-profile-'))
const transcript = []
try {
  for (const mode of ['off', 'on', 'on-unreadable-store']) {
    const directory = join(root, mode)
    await mkdir(directory)
    const cfg = loadConfig({ HGW_STATE_ROOT: directory, HGW_DSH_REPO_ROOT: repository, HGW_GUARD_PATCH: 'off', HGW_REMOTE_DESKTOP: mode === 'off' ? 'off' : 'on' })
    const policy = policyPatchText(cfg, { kind: 'user', admin: false, steward: false })
    if (mode === 'off') assert.ok(!policy.includes(cfg.remoteDesktopDir))
    const patches = yaml.load(policy, { schema: entryListSchema }).filter(patch => desktopIds.has(patch.id))
    const entries = applyEntryPatches(webEntries, patches, message => { throw new Error(message) })
    entries.push({ id: 'typert', name: '@deepseek-ai/dsh-typert-registry' },
      { id: 'desktop-availability', name: '@deepseek-ai/dsh-gateway-execution/desktop-availability' })
    const profile = join(directory, 'cordis.yml')
    await writeFile(profile, yaml.dump(entries))
    if (mode === 'on') {
      await mkdir(cfg.remoteDesktopDir)
      await writeFile(join(cfg.remoteDesktopDir, 'endpoints.json'), JSON.stringify({ endpoints: [{ nodeId: 'external', host: '127.0.0.1', port: 5900 }] }))
    } else await writeFile(cfg.remoteDesktopDir, 'This path is deliberately not a readable desktop store directory.\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(name) { assert.ok(modules.has(name), name); return modules.get(name) },
    }
    const claims = { purpose: undefined, expiresAt: Date.now() + 60_000, user: { username: 'alice', role: 'user' } }
    ctx.provide('executionAuthorityRequired', true)
    ctx.provide('gatewayRuntime', { interactive: () => ({ claims }) })
    try {
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
      await ctx.loader.await()
      if (mode === 'on-unreadable-store') {
        const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'remote-desktop-vnc')
        await assert.rejects(entry.fiber.await(), { code: 'ENOTDIR' })
        assert.equal(ctx.get('remoteDesktop'), undefined)
        assert.ok(ctx.get('remoteDesktopController'))
        transcript.push({ mode, providerPublished: false, startupError: 'ENOTDIR', controllerRetained: true })
        continue
      }
      for (const entry of ctx.loader.entries()) if (entry.fiber !== undefined) await entry.fiber.await()
      const controller = ctx.get('remoteDesktopController')
      assert.ok(controller)
      assert.equal(controller.typertRemote.namespace, 'remoteDesktop')
      assert.ok(ctx.get('computerUseEnvironment'))
      const agent = { id: 'desktop-fixture', ctx }, signal = new AbortController().signal
      if (mode === 'off') {
        assert.equal(ctx.get('remoteDesktop'), undefined)
        assert.deepEqual(await controller.listGrants(agent, { attachable: true }, signal), [])
        await assert.rejects(controller.attach(agent, { nodeId: 'external', level: 'view' }, signal), { code: 'remote-desktop/unavailable' })
        await assert.rejects(controller.revoke(agent, { grantId: 'old' }, signal), { code: 'remote-desktop/forbidden' })
        claims.expiresAt = 0
        await assert.rejects(controller.listGrants(agent, {}, signal), { code: 'remote-desktop/forbidden' })
        transcript.push({ mode, privateFilesExcluded: true, metadataRetained: true, targets: [], connection: 'unavailable', anonymous: 'forbidden' })
      } else {
        const provider = ctx.get('remoteDesktop'), admin = { principal: 'root', admin: true }
        assert.ok(provider)
        const grant = await provider.grant({ target: { nodeId: 'external' }, principal: 'alice', level: 'view', scope: { kind: 'machine' }, recording: false, grantedBy: 'root' }, admin)
        assert.equal((await controller.listGrants(agent, { attachable: true }, signal)).length, 1)
        const request = { principal: 'alice', target: { nodeId: 'external' }, level: 'view' }
        await assert.rejects(provider.attach(request), { code: 'REMOTE_DESKTOP_CONSENT_REQUIRED' })
        await provider.confirm(request)
        await provider.attach(request)
        await provider.revoke(grant.id, admin)
        await assert.rejects(provider.resolve(request), { code: 'REMOTE_DESKTOP_FORBIDDEN' })
        transcript.push({ mode, externalEndpointRetained: true, metadataRetained: true, consentRequired: true, revocation: 'forbidden' })
      }
    } finally { await ctx.fiber.dispose() }
  }
  assert.deepEqual(transcript, JSON.parse(await readFile(new URL('../expected/desktop-profile-built.json', import.meta.url), 'utf8')))
  process.stdout.write(JSON.stringify(transcript) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
