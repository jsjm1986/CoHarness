/**
 * Host routes over a real WebServer booted through the vendored Loader
 * (the REAL-composition requirement), asserting the HTTP surface: the
 * connection trust fence, the one-pass catalog resolution the routes share,
 * icon serving with caching, the open route's wire validation, and the
 * stale-launcher (ENOENT) refresh. Host commands, launches, and PATH
 * resolution are faked through the package `internals` seam; the connection
 * service is a controllable stub (its real provider is the browser
 * composition); the filesystem is real.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import * as OpenInApp from '../src/index.ts'
import { internals } from '../src/internals.ts'
import type { OpenInAppLauncher } from '../src/resolver.ts'

let root: string | undefined
let context: Context | undefined
let withdrawConnection: (() => void | Promise<void>) | undefined
let observeAuthentication: (() => void) | undefined
const statGate = vi.hoisted(() => ({
  path: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
    if (args[0] === statGate.path) { statGate.entered?.(); await statGate.resume }
    return actual.stat(...args)
  } }
})
/** Answer the connection stub gives every route until a test changes it. */
const trust: { rejection: 401 | 403 | undefined } = { rejection: undefined }

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  withdrawConnection = undefined
  observeAuthentication = undefined
  statGate.path = undefined
  statGate.entered = undefined
  statGate.resume = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  internals.catalog = {}
  trust.rejection = undefined
})

/** PATH-resolution fake answering from a fixed name-to-path table. */
function pathTable(entries: Record<string, string> = {}): (name: string) => Promise<string | null> {
  return name => Promise.resolve(entries[name] ?? null)
}

/** Boot webserver + open-in-app rows through the real Loader. */
async function boot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-host-open-in-app'",
    '  config:',
    '    probeTimeoutMs: 5000',
    '    iconTimeoutMs: 5000',
    '    launchWatchMs: 1000',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  withdrawConnection = context.provide('connection', { requestRejection: () => {
    observeAuthentication?.()
    return trust.rejection
  } } as never)
  // The plugin resolves PATH names through the composition's subprocess
  // capability; the not-found rejection is the provider's real signal.
  context.provide('subprocess', {
    resolveExecutable: () => Promise.reject(new Error('spec host resolves nothing')),
  } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-host-open-in-app', OpenInApp],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return `http://127.0.0.1:${String(context.webServer.port)}`
}

/**
 * macOS host with a Cursor bundle (carrying an icon) under the temp
 * application root; the injected launcher records every spawn.
 */
function darwinFixture(home: string, launches: string[][]): void {
  const run: NativeCommandRunner = async (command, args) => {
    if (command === 'plutil') return { stdout: JSON.stringify({ CFBundleIconFile: 'AppIcon' }), stderr: '' }
    if (command === 'sips') {
      const out = args[args.length - 1]
      if (typeof out !== 'string') throw new Error('missing sips --out')
      await writeFile(out, 'png-bytes')
      return { stdout: '', stderr: '' }
    }
    throw new Error(`fixture rejects: ${command} ${args.join(' ')}`)
  }
  const launch: OpenInAppLauncher = (command, args) => {
    launches.push([command, ...args])
    return Promise.resolve()
  }
  internals.catalog = {
    platform: 'darwin',
    applicationRoots: [join(home, 'Applications')],
    run,
    launch,
    resolveExecutable: pathTable(),
  }
}

/** Create the Cursor bundle fixture with an icns under the temp home. */
async function cursorBundle(home: string): Promise<void> {
  await mkdir(join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources'), { recursive: true })
  await writeFile(join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'AppIcon.icns'), 'icns')
}

describe('open-in-app host routes (real Loader composition)', () => {
  it.each(['apps', 'icon', 'open'].flatMap(route =>
    ['authentication', 'plugin', 'qualification'].map(withdrawal => ({ route, withdrawal })),
  ))('refuses $route after $withdrawal withdrawal during catalog resolution', async ({ route, withdrawal }) => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-withdrawal-'))
    const launches: string[][] = []
    let resume!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => { resume = resolve })
    const observed = new Promise<void>((resolve) => { entered = resolve })
    let pending: Promise<Response> | undefined
    try {
      await cursorBundle(home)
      darwinFixture(home, launches)
      const run = internals.catalog.run!
      internals.catalog.run = async (...args) => { entered(); await held; return run(...args) }
      const base = await boot()
      const path = route === 'apps' ? 'apps' : route === 'icon' ? 'icon/cursor' : 'open'
      pending = fetch(`${base}/open-in-app/${path}`, { signal: AbortSignal.timeout(5_000),
        ...route === 'open' ? { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: 'cursor', path: home }) } : {},
      })
      void pending.catch(() => {})
      await observed
      if (withdrawal === 'authentication') await withdrawConnection?.()
      else if (withdrawal === 'qualification') trust.rejection = 403
      else {
        const desktop = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-host-open-in-app')
        await desktop!.fiber!.dispose()
      }
      resume()
      const response = await pending
      await response.arrayBuffer()
      expect({ status: response.status, launches }).toEqual({
        status: withdrawal === 'qualification' ? 403 : 503, launches: [],
      })
    } finally {
      resume()
      if (pending !== undefined) await Promise.allSettled([pending])
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each(['authentication', 'plugin', 'qualification'].flatMap(withdrawal =>
    ['initial', 'refreshed'].map(phase => ({ withdrawal, phase })),
  ))('refuses the $phase fallback after $withdrawal withdrawal', async ({ withdrawal, phase }) => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-fallback-'))
    const developer = join(home, 'Xcode.app', 'Contents', 'Developer'), launches: string[] = []
    let resume!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => { resume = resolve })
    const observed = new Promise<void>((resolve) => { entered = resolve })
    let pending: Promise<Response> | undefined
    try {
      await mkdir(developer, { recursive: true })
      internals.catalog = { platform: 'darwin', applicationRoots: [], resolveExecutable: pathTable(),
        run: async () => ({ stdout: developer, stderr: '' }),
        launch: async (command) => {
          launches.push(command)
          if (phase === 'refreshed' && launches.length <= 2) throw Object.assign(new Error('launcher removed'), { code: 'ENOENT' })
          entered(); await held; throw new Error('primary launcher failed')
        },
      }
      const base = await boot()
      pending = fetch(`${base}/open-in-app/open`, { method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'xcode', path: home }),
      })
      void pending.catch(() => {})
      await observed
      if (withdrawal === 'authentication') await withdrawConnection?.()
      else if (withdrawal === 'qualification') trust.rejection = 403
      else {
        const desktop = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-host-open-in-app')
        await desktop!.fiber!.dispose()
      }
      resume()
      const response = await pending
      await response.arrayBuffer()
      expect({ status: response.status, launches }).toEqual({
        status: withdrawal === 'qualification' ? 403 : 503, launches: phase === 'initial' ? ['xed'] : ['xed', 'open', 'xed'],
      })
    } finally {
      resume()
      if (pending !== undefined) await Promise.allSettled([pending])
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each(['path', 'refresh'])('refuses launch after qualification withdrawal during the %s read', async (phase) => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-stat-withdrawal-'))
    const launches: string[][] = []
    let resume!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => { resume = resolve })
    const observed = new Promise<void>((resolve) => { entered = resolve })
    let pending: Promise<Response> | undefined
    try {
      await cursorBundle(home)
      darwinFixture(home, launches)
      statGate.entered = entered; statGate.resume = held
      if (phase === 'path') statGate.path = home
      else internals.catalog.launch = async (command, args) => {
        launches.push([command, ...args]); statGate.path = join(home, 'Applications', 'Cursor.app')
        throw Object.assign(new Error('launcher removed'), { code: 'ENOENT' })
      }
      const base = await boot()
      pending = fetch(`${base}/open-in-app/open`, { method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'cursor', path: home }),
      })
      void pending.catch(() => {})
      await observed
      trust.rejection = 403
      resume()
      const response = await pending
      await response.arrayBuffer()
      expect(response.status).toBe(403)
      expect(launches).toHaveLength(phase === 'path' ? 0 : 1)
    } finally {
      resume()
      if (pending !== undefined) await Promise.allSettled([pending])
      statGate.path = undefined
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refuses a request whose qualification is withdrawn while its body is arriving', async () => {
    const base = await boot()
    let entered!: () => void
    const observed = new Promise<void>((resolve) => { entered = resolve })
    observeAuthentication = entered
    const incoming = request(`${base}/open-in-app/open`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
    })
    const received = new Promise<number | undefined>((resolve, reject) => {
      incoming.once('error', reject)
      incoming.once('response', (response) => { response.resume(); response.once('end', () => { resolve(response.statusCode) }) })
    })
    void received.catch(() => {})
    try {
      incoming.write('{')
      await observed
      trust.rejection = 403
      incoming.end('}')
      expect(await received).toBe(403)
    } finally {
      incoming.destroy()
      await Promise.allSettled([received])
    }
  })

  it.each(['authentication', 'plugin', 'qualification'])('withholds extracted icon bytes after %s withdrawal', async (withdrawal) => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-icon-withdrawal-'))
    let resume!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => { resume = resolve })
    const observed = new Promise<void>((resolve) => { entered = resolve })
    let pending: Promise<Response> | undefined
    try {
      await cursorBundle(home)
      darwinFixture(home, [])
      const run = internals.catalog.run!
      internals.catalog.run = async (...args) => {
        if (args[0] === 'plutil') { entered(); await held }
        return run(...args)
      }
      const base = await boot()
      await (await fetch(`${base}/open-in-app/apps`)).arrayBuffer()
      pending = fetch(`${base}/open-in-app/icon/cursor`, { signal: AbortSignal.timeout(5_000) })
      void pending.catch(() => {})
      await observed
      if (withdrawal === 'authentication') await withdrawConnection?.()
      else if (withdrawal === 'qualification') trust.rejection = 403
      else {
        const desktop = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-host-open-in-app')
        await desktop!.fiber!.dispose()
      }
      resume()
      const response = await pending, text = await response.text()
      expect(response.status).toBe(withdrawal === 'qualification' ? 403 : 503)
      expect(text).not.toContain('png-bytes')
    } finally {
      resume()
      if (pending !== undefined) await Promise.allSettled([pending])
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps the function-plugin runtime surface to Loader exports', () => {
    expect(Object.keys(OpenInApp).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })

  it('answers the connection rejection on every route, before any resolution runs', async () => {
    const run = vi.fn<NativeCommandRunner>()
    internals.catalog = { platform: 'darwin', run, resolveExecutable: pathTable() }
    const base = await boot()
    trust.rejection = 403
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/icon/finder`)).status).toBe(403)
    expect((await fetch(`${base}/open-in-app/open`, { method: 'POST' })).status).toBe(403)
    // Rejected requests never reached the lazy catalog resolution.
    expect(run).not.toHaveBeenCalled()
    trust.rejection = 401
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(401)
    trust.rejection = undefined
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
  })

  it('serves the resolved catalog, one cached icon, and launches from the same resolution', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    darwinFixture(home, launches)
    const base = await boot()
    try {
      const apps = await fetch(`${base}/open-in-app/apps`)
      expect(apps.status).toBe(200)
      expect(apps.headers.get('cache-control')).toBe('no-store')
      expect(await apps.json()).toEqual({ apps: ['finder', 'cursor', 'terminal'] })

      const icon = await fetch(`${base}/open-in-app/icon/cursor`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get('content-type')).toBe('image/png')
      expect(await icon.text()).toBe('png-bytes')
      // Second read serves the per-process cache (same bytes, no re-extraction).
      expect(await (await fetch(`${base}/open-in-app/icon/cursor`)).text()).toBe('png-bytes')

      expect((await fetch(`${base}/open-in-app/icon/nonesuch`)).status).toBe(404)

      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'cursor', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(await open.json()).toEqual({ ok: true })
      // The launcher is the resolution's verified bundle, not a re-probe.
      expect(launches).toEqual([['open', '-a', join(home, 'Applications', 'Cursor.app'), workspace]])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('resolves the catalog once: list reads, menu opens, and launches share the pass', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    darwinFixture(home, launches)
    const resolveExecutable = vi.fn(pathTable())
    internals.catalog = { ...internals.catalog, resolveExecutable }
    const base = await boot()
    try {
      // Two list reads and a launch: detection ran once (macOS resolution
      // here is filesystem-only; the PATH resolver seat is the witness that
      // no second pass started).
      await fetch(`${base}/open-in-app/apps`)
      await fetch(`${base}/open-in-app/apps`)
      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'cursor', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(launches).toHaveLength(1)
      expect(resolveExecutable).not.toHaveBeenCalled()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('refreshes one entry after a missing launcher and drops it when it no longer resolves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await cursorBundle(home)
    await mkdir(workspace, { recursive: true })
    const attempts: string[][] = []
    const enoent = (): Promise<void> => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    // First launch attempt: the resolved executable is gone; after the
    // refresh, the retried launch succeeds. Outcomes are thunks so no
    // rejection exists before the launcher consumes it.
    let launchOutcomes = [enoent, (): Promise<void> => Promise.resolve()]
    const launch: OpenInAppLauncher = (command, args) => {
      attempts.push([command, ...args])
      const next = launchOutcomes.shift()
      if (next === undefined) throw new Error('unexpected launch attempt')
      return next()
    }
    internals.catalog = {
      platform: 'darwin',
      applicationRoots: [join(home, 'Applications')],
      run: () => Promise.reject(new Error('fixture rejects')),
      launch,
      resolveExecutable: pathTable(),
    }
    const base = await boot()
    const openCursor = (): Promise<Response> => fetch(`${base}/open-in-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'cursor', path: workspace }),
    })
    try {
      expect((await openCursor()).status).toBe(200)
      // Two attempts: the stale launcher, then the freshly resolved one.
      expect(attempts).toHaveLength(2)

      // Remove the bundle: the next missing launch cannot re-resolve, the
      // route reports the failure, and the entry leaves the served list.
      await rm(join(home, 'Applications', 'Cursor.app'), { recursive: true, force: true })
      launchOutcomes = [enoent]
      expect((await openCursor()).status).toBe(502)
      expect(await (await fetch(`${base}/open-in-app/apps`)).json())
        .toEqual({ apps: ['finder', 'terminal'] })
      // The unresolved entry also stops serving an icon.
      expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
      expect((await openCursor()).status).toBe(400)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rejects wrong methods, non-JSON content, malformed bodies, unknown apps, and bad paths', async () => {
    const launches: string[][] = []
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    await cursorBundle(home)
    darwinFixture(home, launches)
    const base = await boot()
    try {
      const wrongMethodApps = await fetch(`${base}/open-in-app/apps`, { method: 'POST' })
      expect(wrongMethodApps.status).toBe(405)
      expect(wrongMethodApps.headers.get('allow')).toBe('GET')
      expect((await fetch(`${base}/open-in-app/icon/cursor`, { method: 'POST' })).status).toBe(405)
      const wrongMethodOpen = await fetch(`${base}/open-in-app/open`)
      expect(wrongMethodOpen.status).toBe(405)
      expect(wrongMethodOpen.headers.get('allow')).toBe('POST')

      // Body-format validation: only an application/json ESSENCE is accepted;
      // a parameter smuggling the token elsewhere does not count.
      const form = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'app=cursor',
      })
      expect(form.status).toBe(415)
      const smuggled = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;x=application/json' },
        body: JSON.stringify({ app: 'cursor', path: home }),
      })
      expect(smuggled.status).toBe(415)

      const post = (body: string): Promise<Response> => fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      })
      expect((await post('not json')).status).toBe(400)
      expect((await post('7')).status).toBe(400)
      expect((await post('null')).status).toBe(400)
      expect((await post(JSON.stringify(['array'])) ).status).toBe(400)
      expect((await post(JSON.stringify({ app: 7, path: '/tmp' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'vscode', path: home }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'nonesuch', path: home }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: 'relative/dir' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: '' }))).status).toBe(400)
      expect((await post(JSON.stringify({ app: 'cursor', path: join(home, 'missing') }))).status).toBe(404)
      const oversize = await post(JSON.stringify({ app: 'cursor', path: '/'.padEnd(70_000, 'x') }))
      expect(oversize.status).toBe(413)
      expect(launches).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reports a failed launcher as 502 and an empty catalog on a platform without entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    internals.catalog = {
      platform: 'darwin',
      applicationRoots: [join(home, 'Applications')],
      run: () => Promise.reject(new Error('down')),
      launch: () => Promise.reject(new Error('down')),
      resolveExecutable: pathTable(),
    }
    const base = await boot()
    try {
      // finder/terminal resolve (fixed entries) but their launch fails.
      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'finder', path: workspace }),
      })
      expect(open.status).toBe(502)
      // An unresolved entry stays rejected as unavailable.
      expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
    } finally {
      await rm(home, { recursive: true, force: true })
    }

    await context?.fiber.dispose()
    context = undefined
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const emptyBase = await boot()
    expect(await (await fetch(`${emptyBase}/open-in-app/apps`)).json()).toEqual({ apps: [] })
  })

  it('serves a Linux catalog resolved in-process and its desktop-entry SVG icon', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-home-'))
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const applications = join(home, '.local', 'share', 'applications')
    await mkdir(applications, { recursive: true })
    const svg = join(home, 'code.svg')
    await writeFile(svg, '<svg/>')
    await writeFile(join(applications, 'code.desktop'), `[Desktop Entry]\nExec=code\nIcon=${svg}\n`)
    const launches: string[][] = []
    const launch: OpenInAppLauncher = (command, args) => {
      launches.push([command, ...args])
      return Promise.resolve()
    }
    internals.catalog = {
      platform: 'linux',
      home,
      env: { XDG_DATA_DIRS: join(home, 'xdg-empty'), DISPLAY: ':0' },
      run: () => Promise.reject(new Error('fixture rejects')),
      launch,
      resolveExecutable: pathTable({ 'xdg-open': '/usr/bin/xdg-open', code: '/usr/bin/code' }),
    }
    const base = await boot()
    try {
      expect(await (await fetch(`${base}/open-in-app/apps`)).json())
        .toEqual({ apps: ['filemanager', 'vscode'] })
      // The icon follows the desktop entry; xdg-open declares none.
      const icon = await fetch(`${base}/open-in-app/icon/vscode`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get('content-type')).toBe('image/svg+xml')
      expect(await icon.text()).toBe('<svg/>')
      expect((await fetch(`${base}/open-in-app/icon/filemanager`)).status).toBe(404)

      const open = await fetch(`${base}/open-in-app/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'vscode', path: workspace }),
      })
      expect(open.status).toBe(200)
      expect(launches).toEqual([['/usr/bin/code', workspace]])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('answers 400 when the connection dies mid-body', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    const port = Number(new URL(base).port)
    // A declared body the client never finishes: destroying the socket makes
    // the request stream error inside readBoundedBody.
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          'POST /open-in-app/open HTTP/1.1',
          'host: 127.0.0.1',
          'content-type: application/json',
          'content-length: 100',
          '',
          '{"app":',
        ].join('\r\n'))
        setTimeout(() => { socket.destroy() }, 50)
      })
      let answer = ''
      socket.on('data', (chunk) => { answer += String(chunk) })
      socket.on('close', () => { resolve(answer) })
      socket.on('error', reject)
    })
    // The server sent its refusal before our destroy landed, or the exchange
    // simply died first — either way the handler must not crash the process.
    expect(status === '' || status.startsWith('HTTP/1.1 400')).toBe(true)
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
  })

  it('resolves PATH names through the composition subprocess capability when the seam does not override it', async () => {
    internals.catalog = {
      platform: 'linux',
      env: { XDG_DATA_DIRS: '/nonexistent-xdg' },
      home: '/nonexistent-home',
      run: () => Promise.reject(new Error('fixture rejects')),
    }
    const base = await boot()
    // The spec host's subprocess stub rejects every lookup, which the plugin
    // reads as not-on-PATH: the catalog resolves empty instead of failing.
    expect(await (await fetch(`${base}/open-in-app/apps`)).json()).toEqual({ apps: [] })
  })

  it('removes all three routes when the plugin row is disposed (HMR safety)', async () => {
    internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
    const base = await boot()
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(200)
    const entry = [...(context as Context).loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-host-open-in-app')
    await entry?.fiber?.dispose()
    // The webserver survives; the routes are gone (its 404 fallback answers).
    expect((await fetch(`${base}/open-in-app/apps`)).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/icon/cursor`)).status).toBe(404)
    expect((await fetch(`${base}/open-in-app/open`, { method: 'POST' })).status).toBe(404)
  })
})

it('rejects remote or absent Host headers and permits loopback IPv6 spelling', async () => {
  internals.catalog = { platform: 'aix', resolveExecutable: pathTable() }
  const base = await boot()
  const port = Number(new URL(base).port)
  for (const [host, status] of [['remote.example', '403'], ['[::1]', '200'], [undefined, '403']] as const) {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET /open-in-app/apps HTTP/1.0\r\n${host === undefined ? '' : `Host: ${host}\r\n`}\r\n`)
      })
      let data = ''
      socket.on('data', (chunk) => { data += String(chunk) })
      socket.on('end', () => { resolve(data) })
      socket.on('error', reject)
    })
    expect(response.split('\r\n')[0]).toContain(status)
  }
})
