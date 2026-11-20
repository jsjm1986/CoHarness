/** Discover and install through built dsh web, a private profile and an isolated registry. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { initProfile, readProfileManifest, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { parseDocument } from 'yaml'
import type { MarketSearchResult } from '@deepseek-ai/dsh-plugin-market/types'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Browser, Locator, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { watchConsole, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'

const FEATURED = 'Workspace notes with a deliberately long localized plugin title'
const FEATURED_PACKAGE = '@fixture/responsive-market-00'
const INSTALLED = '@fixture/market-installed'
const UPDATE = '@fixture/market-update'
const DIFFERENT = '@fixture/market-different'
const PROVIDED = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const EXEMPT = '@fixture/market-exempt'
const BLOCKED = '@fixture/market-blocked'
const SUCCESS = '@fixture/market-success'
const SUCCESS_TITLE = 'Locally published installation acceptance bundle'
const MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
const PROFILE = 'market-acceptance'
const run = promisify(execFile)

interface BundleFact {
  name: string
  version?: string
  installed: boolean
  optional: boolean
}

function statusMarket(origin: string, providedVersion: string): object {
  const entry = (name: string, title: string, version: string, incompatible = false) => ({
    name, title, description: `Read the current installation and compatibility state of ${title}.`,
    versions: [{ version, publishTimestamp: 1_700_000_002,
      source: { type: 'npm', registry: `${origin}/registry/` },
      ...incompatible ? { engines: { dsh: '>=999.0.0' } } : {},
    }],
  })
  return { format: 1, title: 'Installation status acceptance', plugins: [
    entry(INSTALLED, 'Installed acceptance bundle', '1.0.0'),
    entry(UPDATE, 'Updatable acceptance bundle', '2.0.0'),
    entry(DIFFERENT, 'Different installed version', '1.0.0'),
    entry(PROVIDED, 'Shipped voice input', providedVersion),
    entry(EXEMPT, 'Exact-version exemption', '1.0.0', true),
    entry(BLOCKED, 'Incompatible without exemption', '1.0.0', true),
  ] }
}

function market(origin: string, empty = false): object {
  return {
    format: 1,
    title: { en: 'Private acceptance market', zh: '私有验收市场' },
    description: { en: 'Locally published packages for the isolated acceptance profile.', zh: '为隔离验收配置发布的本地插件。' },
    metadata: {
      categories: { tools: { title: 'Developer tools' }, writing: { title: 'Writing and documents' } },
      labels: { reviewed: { title: 'Reviewed source' }, local: { title: 'Local workflow' } },
      sortKeys: { score: { title: 'Review score', order: 'desc' } },
    },
    plugins: empty ? [] : Array.from({ length: 53 }, (_, index) => ({
      name: `@fixture/responsive-market-${String(index).padStart(2, '0')}`,
      title: { en: index === 0 ? FEATURED : `Acceptance extension ${String(index).padStart(2, '0')}`, zh: `验收插件 ${index}` },
      description: 'A readable description explains the capability before installation. '.repeat(index === 0 ? 3 : 1),
      author: 'Local acceptance publisher', icon: `${origin}/missing-icon.png`,
      homepage: `${origin}/about/extension/${index}`,
      repository: { url: 'https://example.invalid/acceptance/extensions', directory: `packages/extension-${index}` },
      metadata: { category: index % 2 === 0 ? 'tools' : 'writing', keywords: ['acceptance'],
        labels: index % 3 === 0 ? ['reviewed', 'local'] : ['local'], sortKeys: { score: index } },
      versions: [
        { version: '2.0.0-beta.1', publishTimestamp: 1_700_000_003, source: { type: 'npm', registry: `${origin}/registry/` }, engines: { dsh: '>=999.0.0' } },
        { version: '1.0.0', publishTimestamp: 1_700_000_002, source: { type: 'npm', registry: `${origin}/registry/` } },
        { version: '0.9.0', publishTimestamp: 1_700_000_001, source: { type: 'git', url: 'https://example.invalid/acceptance/extensions.git',
          commit: '0123456789abcdef0123456789abcdef01234567', path: `packages/extension-${index}` } },
      ],
    })),
  }
}

describe('web e2e: plugin market discovery', () => {
  const subprocessCtx = new Context()
  let host: SubprocessHandle | undefined
  let authenticatedUrl: URL
  let sessionCookie: string
  let profileDir: string
  let browser: Browser
  let publisher: Server
  let scratch: string
  let origin: string
  let indexStatus = 200
  let indexGate: Promise<void> | undefined
  let releaseIndex: (() => void) | undefined
  let registryReads = 0
  let providedVersion: string
  let tarball: Buffer
  let activationMarker: string
  let installReady: string
  let installRelease: string
  let tarballReads = 0

  async function invoke<T>(method: string, args: object): Promise<T> {
    const response = await fetch(new URL(`/api/${method}`, authenticatedUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
    expect(response.status).toBe(200)
    const answer = await response.json() as { result: { ok: true; value: T } | { ok: false; error: { message: string } } }
    if (!answer.result.ok) throw new Error(`${method}: ${answer.result.error.message}`)
    return answer.result.value
  }

  beforeAll(async () => {
    if (webSnapshotMode() === 'refresh') await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/plugin-market'), { recursive: true })
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'dsh-market-responsive-')))
    const home = join(scratch, 'home')
    profileDir = join(home, 'profiles', PROFILE)
    activationMarker = join(scratch, 'activated')
    installReady = join(scratch, 'install-ready')
    installRelease = join(scratch, 'install-release')
    const packageRoot = join(scratch, 'published')
    const packageDir = join(packageRoot, 'package')
    await mkdir(packageDir, { recursive: true })
    const manifest = { name: SUCCESS, version: '1.0.0', type: 'module', main: './index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }
    await writeFile(join(packageDir, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: market-success-probe\n      name: ./index.js\n')
    await writeFile(join(packageDir, 'index.js'), [
      "import { rmSync, writeFileSync } from 'node:fs'",
      'export function apply(ctx) {',
      '  ctx.effect(() => {',
      `    writeFileSync(${JSON.stringify(activationMarker)}, 'active')`,
      `    return () => rmSync(${JSON.stringify(activationMarker)}, { force: true })`,
      '  })', '}', '',
    ].join('\n'))
    const archive = join(scratch, 'market-success.tgz')
    await run('tar', ['-czf', archive, '-C', packageRoot, 'package'])
    tarball = await readFile(archive)
    const pnpm = join(scratch, 'private-pnpm.mjs')
    const privateConfig = join(scratch, 'npmrc')
    const privateGlobalConfig = join(scratch, 'global-npmrc')
    await writeFile(privateConfig, '')
    await writeFile(privateGlobalConfig, '')
    await writeFile(pnpm, [
      '#!/usr/bin/env node',
      "import { existsSync, realpathSync, writeFileSync } from 'node:fs'",
      "import { spawn } from 'node:child_process'",
      "import { setTimeout } from 'node:timers/promises'",
      `if (realpathSync(process.cwd()) !== ${JSON.stringify(profileDir)}) throw new Error('Package operation escaped its private acceptance profile')`,
      'const args = process.argv.slice(2)',
      `if (args[0] === 'add' && args.some(arg => arg.startsWith(${JSON.stringify(`${SUCCESS}@`)}))) {`,
      `  writeFileSync(${JSON.stringify(installReady)}, 'entered')`,
      `  while (!existsSync(${JSON.stringify(installRelease)})) await setTimeout(25)`,
      '}',
      'const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(npm_config_|pnpm_)/i.test(key)))',
      `env.npm_config_userconfig = ${JSON.stringify(privateConfig)}`,
      `env.npm_config_globalconfig = ${JSON.stringify(privateGlobalConfig)}`,
      ...['CACHE', 'CONFIG', 'DATA', 'STATE'].map(name => `env.XDG_${name}_HOME = ${JSON.stringify(join(scratch, name.toLowerCase()))}`),
      `env.PNPM_HOME = ${JSON.stringify(join(scratch, 'pnpm-home'))}`,
      `const child = spawn(process.execPath, [${JSON.stringify(join(REPO_ROOT, 'node_modules/pnpm/bin/pnpm.mjs'))}, ...args], { env, stdio: 'inherit' })`,
      "process.on('SIGTERM', () => child.kill('SIGTERM'))",
      "process.on('SIGINT', () => child.kill('SIGINT'))",
      "child.on('error', error => { console.error(error.message); process.exitCode = 1 })",
      "child.on('exit', code => { process.exitCode = code ?? 1 })", '',
    ].join('\n'), { mode: 0o700 })
    publisher = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path.startsWith('/registry/')) {
        registryReads++
        if (path === '/registry/market-success.tgz') {
          tarballReads++
          response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(tarball); return
        }
        if (decodeURIComponent(path).replace(/\/$/u, '') === `/registry/${SUCCESS}`) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ name: SUCCESS, 'dist-tags': { latest: '1.0.0' },
            time: { '1.0.0': '2023-11-14T22:13:20.000Z' }, versions: { '1.0.0': { ...manifest,
              dist: { tarball: `${origin}/registry/market-success.tgz`, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` },
            } } }))
          return
        }
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'The acceptance registry has no published tarball.' }))
        return
      }
      if (!['/index.json', '/empty.json', '/invalid.json', '/statuses.json', '/success.json'].includes(path)) {
        response.writeHead(404); response.end(); return
      }
      void Promise.resolve(indexGate).then(() => {
        if (response.destroyed) return
        response.writeHead(indexStatus, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(path === '/invalid.json' ? { format: 999 }
          : path === '/statuses.json' ? statusMarket(origin, providedVersion)
            : path === '/success.json' ? { format: 1, title: 'Private installation acceptance', plugins: [{ name: SUCCESS,
              title: SUCCESS_TITLE, description: 'A local package whose activation is confined to the acceptance directory.',
              versions: [{ version: '1.0.0', publishTimestamp: 1_700_000_002, source: { type: 'npm', registry: `${origin}/registry/` } }],
            }] } : market(origin, path === '/empty.json')))
      })
    })
    await new Promise<void>((resolve, reject) => {
      publisher.once('error', reject)
      publisher.listen(0, '127.0.0.1', resolve)
    })
    const address = publisher.address()
    if (address === null || typeof address === 'string') throw new Error('Market publisher did not bind TCP')
    origin = `http://127.0.0.1:${address.port}`
    initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', MARKET_BUNDLE])
    const overlay = join(scratch, 'market.patch.yml')
    await writeFile(overlay, [
      '- id: plugin-market', '  config:', '    fetchTimeoutMs: 600000',
      '- id: plugin-manager', '  config:', `    registry: ${JSON.stringify(`${origin}/registry/`)}`, '    fallbackRegistries: []',
      `    pnpmCommand: ${JSON.stringify(pnpm)}`,
      '- id: ui-plugin-manager', '  config:', '    registryProbeEnabled: false',
      '- id: userdoc-local', '  config:', `    uploadRoot: ${JSON.stringify(join(scratch, 'documents'))}`, '',
    ].join('\n'))
    const bundle = join(REPO_ROOT, 'packages/experimental/plugin-market-bundle')
    const packages = new Map([[MARKET_BUNDLE, bundle]])
    for (const [name, version] of [[INSTALLED, '1.0.0'], [UPDATE, '1.0.0'], [DIFFERENT, '3.0.0']] as const) {
      const directory = join(scratch, name.slice('@fixture/'.length))
      await mkdir(directory)
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, type: 'module', main: './index.js',
        description: 'An isolated, installed acceptance bundle with no plugin effects.', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await writeFile(join(directory, 'cordis.patch.yml'), '[]\n')
      await writeFile(join(directory, 'index.js'), 'export {}\n')
      packages.set(name, directory)
    }
    const profileManifest = readProfileManifest('market acceptance', profileDir)
    const dependencies = { ...profileManifest.dependencies }
    // Link the existing fixtures so pnpm can install the new bundle without rebuilding the workspace.
    for (const [name, directory] of packages) {
      const installedPath = join(profileDir, 'node_modules', name)
      await mkdir(dirname(installedPath), { recursive: true })
      await symlink(directory, installedPath, 'junction')
      dependencies[name] = `link:${directory}`
    }
    writeProfileManifest(profileDir, { ...profileManifest, dependencies })
    const policyPath = join(profileDir, 'pnpm-workspace.yaml')
    const policy = parseDocument(await readFile(policyPath, 'utf8'))
    policy.set('storeDir', join(scratch, 'store'))
    policy.set('cacheDir', join(scratch, 'cache'))
    policy.set('autoInstallPeers', false)
    await writeFile(policyPath, String(policy))
    // Installation and HMR must operate on the same root Include owned by the published host.
    const launch = resolveExampleLaunch({
      srcBin: join(REPO_ROOT, 'apps/cli/src/bin.ts'), mode: 'lib',
      configArgs: ['--profile', PROFILE, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
      env: {
        NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: undefined,
        DSH_HOME: home, DSH_AGENTS_HOME: join(scratch, 'agents'),
        DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-market-no-model-call',
      },
    })
    await subprocessCtx.plugin(LocalSubprocessRuntime)
    const child = await subprocessCtx.subprocess.spawn({
      argv: [launch.command, ...launch.args], cwd: scratch, env: launch.env, graceMs: 5_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32_768 }, stderr: { maxBytes: 32_768 } },
    })
    host = child
    let exitStatus: string | undefined
    void child.done.then(
      (result) => { exitStatus = JSON.stringify(result) },
      (error: unknown) => { exitStatus = String(error) },
    )
    const startup = await vi.waitUntil(() => {
      if (exitStatus !== undefined) throw new Error(`Market Web exited before startup: ${exitStatus}`)
      const stdout = child.collected.stdout?.readFrom(0).text ?? ''
      return /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/mu.exec(stdout)?.[1]
    }, { timeout: 60_000 }).catch((error: unknown) => {
      const stderr = child.collected.stderr?.readFrom(0).text ?? ''
      throw new Error(`Market Web did not start:\n${stderr}`, { cause: error })
    })
    authenticatedUrl = new URL(startup)
    const exchange = await fetch(authenticatedUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    sessionCookie = exchange.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    await exchange.body?.cancel()
    expect(sessionCookie.length, 'Market Web browser session cookie').toBeGreaterThan(0)
    const supplied = (await invoke<BundleFact[]>('pluginManager/listBundles', {})).find(entry => entry.name === PROVIDED)
    expect(supplied).toMatchObject({ installed: false, optional: true })
    if (supplied?.version === undefined) throw new Error('Shipped voice bundle has no readable installed version')
    providedVersion = supplied.version
    browser = await responsiveBrowser.launch()
  }, 120_000)
  afterAll(async () => {
    const failures: unknown[] = []
    for (const dispose of [
      async () => {
        releaseIndex?.()
        if (installRelease !== undefined) await writeFile(installRelease, 'released')
      },
      () => browser?.close(),
      async () => {
        if (host === undefined) return
        host.terminate()
        expect(await host.waitForExit(AbortSignal.timeout(15_000))).toBe(true)
        expect(await host.done).toEqual({ exitCode: 0, signal: null })
        expect(existsSync(activationMarker), 'market plugin effect is disposed at host shutdown').toBe(false)
      },
      () => subprocessCtx.fiber.dispose(),
      () => publisher && new Promise<void>((resolve, reject) => {
        publisher.closeAllConnections()
        publisher.close((error) => { if (error) reject(error); else resolve() })
      }),
      () => scratch && rm(scratch, { recursive: true, force: true }),
    ]) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Market fixture teardown failed')
  })

  async function activate(control: Locator): Promise<void> {
    if (workflowMatrixEnabled) await control.tap()
    else await control.click()
  }

  async function open(): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const page = await newWorkflowPage(browser)
    const tripwire = watchConsole(page)
    page.setDefaultTimeout(15_000)
    try {
      await page.goto(authenticatedUrl.href, { waitUntil: 'domcontentloaded' })
      await activate(page.getByRole('navigation', { name: 'Panels', exact: true }).getByRole('button', { name: 'Plugins', exact: true }))
      await activate(page.getByRole('tab', { name: 'Discover', exact: true }))
      await page.locator('[data-plugin-tab="discover"]').waitFor()
      return { page, tripwire }
    } catch (error) {
      try { await saveFailureShot(page, 'plugin-market-open') } finally { await page.close() }
      throw error
    }
  }

  async function sources(page: Page): Promise<Locator> {
    await activate(page.getByRole('button', { name: /^Switch plugin market, currently /u }))
    await activate(page.getByRole('menuitem', { name: 'Manage index sources…', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Index sources', exact: true })
    await dialog.waitFor()
    return dialog
  }

  it('edits sources, browses and filters real index pages, and hands a confirmed version to the installer', async () => {
    const { page, tripwire } = await open()
    const section = page.locator('[data-plugin-tab="discover"]')
    try {
      await section.getByText('No plugin markets yet', { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'no-sources', section)
      await activate(section.getByRole('button', { name: 'Add index source', exact: true }))
      const dialog = page.getByRole('dialog', { name: 'Index sources', exact: true })
      const url = dialog.getByRole('textbox', { name: 'Index URL', exact: true })
      await auditWorkflowState(page, 'plugin-market', 'source-editor', dialog)
      await url.fill('file:///not-a-published-index')
      await activate(dialog.getByRole('button', { name: 'Add', exact: true }))
      await dialog.getByText('Use an http or https address without a user name, password, or # fragment.', { exact: true }).waitFor()
      expect(await url.getAttribute('aria-invalid')).toBe('true')
      await auditWorkflowState(page, 'plugin-market', 'invalid-source', dialog)
      indexGate = new Promise<void>((resolve) => { releaseIndex = resolve })
      await url.fill(`${origin}/index.json`)
      await activate(dialog.getByRole('button', { name: 'Add', exact: true }))
      await dialog.getByRole('button', { name: `Remove ${origin}/index.json`, exact: true }).waitFor()
      await activate(dialog.getByRole('button', { name: 'Close', exact: true }))
      await section.getByRole('status', { name: 'Reading the index', exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'index-loading', section)
      releaseIndex?.(); indexGate = undefined
      await section.locator('[data-market-entry]').first().waitFor()
      await expect.poll(() => section.locator('[data-market-entry]').count()).toBe(50)
      await auditWorkflowState(page, 'plugin-market', 'first-page', section)
      await activate(section.getByRole('button', { name: 'Show more', exact: true }))
      await expect.poll(() => section.locator('[data-market-entry]').count()).toBe(53)
      expect(await section.getByRole('button', { name: 'Show more', exact: true }).count()).toBe(0)
      await auditWorkflowState(page, 'plugin-market', 'last-page', section)
      await sources(page)
      await url.fill(`${origin}/index.json`)
      await activate(dialog.getByRole('button', { name: 'Add', exact: true }))
      await dialog.getByText('This index source is already added.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'duplicate-source', dialog)
      await activate(dialog.getByRole('button', { name: 'Close', exact: true }))
      const search = section.getByRole('searchbox', { name: 'Search plugins', exact: true })
      await search.fill('no-such-acceptance-extension')
      await section.getByText('No plugins match.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'no-search-results', section)
      await search.fill('')
      await section.locator('[data-market-entry]').first().waitFor()
      await activate(section.getByRole('group', { name: 'Categories', exact: true }).getByRole('button', { name: 'Developer tools', exact: true }))
      await expect.poll(() => section.locator('[data-market-entry]').count()).toBe(27)
      await auditWorkflowState(page, 'plugin-market', 'category-filtered', section)
      await activate(section.getByRole('button', { name: 'Labels', exact: true }))
      const menu = page.getByRole('menu')
      await auditWorkflowState(page, 'plugin-market', 'label-menu', menu)
      await activate(menu.getByRole('menuitem', { name: 'Reviewed source', exact: true }))
      await expect.poll(() => section.locator('[data-market-entry]').count()).toBe(9)
      await page.keyboard.press('Escape')
      await auditWorkflowState(page, 'plugin-market', 'labels-filtered', section)
      await activate(section.getByRole('button', { name: /^Sort: /u }))
      await auditWorkflowState(page, 'plugin-market', 'sort-menu', menu)
      await activate(menu.getByRole('menuitem', { name: 'Review score', exact: true }))
      await expect.poll(() => section.locator('[data-market-entry]').first().getAttribute('data-market-entry')).toBe('@fixture/responsive-market-48')
      await activate(section.getByRole('button', { name: /^Sort: /u }))
      await activate(menu.getByRole('menuitem', { name: 'Sort ascending', exact: true }))
      await expect.poll(() => section.locator('[data-market-entry]').first().getAttribute('data-market-entry')).toBe(FEATURED_PACKAGE)
      await auditWorkflowState(page, 'plugin-market', 'sorted-ascending', section)
      await activate(section.getByRole('button', { name: `View ${FEATURED}`, exact: true }))
      const detail = section.locator('[data-market-detail]')
      await detail.getByText('Incompatible', { exact: true }).waitFor()
      expectTextContrast(await captureTextContrast(page,
        ['outline', 'info', 'neutral', 'warning'].map(tone => ({
          label: tone, text: detail.locator(`[data-tone="${tone}"]`).first(),
        })), 'market-entry-tags'))
      await auditWorkflowState(page, 'plugin-market', 'entry-and-versions', detail)
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/plugin-market/entry.expected.md'),
        (await detail.ariaSnapshot()).replaceAll(origin, '{{publisher}}'), webSnapshotMode())
      const install = detail.getByRole('button', { name: `Install ${FEATURED}`, exact: true })
      await activate(install)
      const confirmation = page.getByRole('dialog', { name: `Install "${FEATURED}"?`, exact: true })
      await auditWorkflowState(page, 'plugin-market', 'installation-trust', confirmation)
      await activate(confirmation.getByRole('button', { name: 'Cancel', exact: true }))
      expect(registryReads).toBe(0)
      await activate(install)
      await activate(confirmation.getByRole('button', { name: 'Install', exact: true }))
      const installer = page.getByRole('dialog').filter({ has: page.locator('[data-install-phase]') })
      await installer.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 60_000 })
      expect(registryReads).toBeGreaterThan(0)
      await auditWorkflowState(page, 'plugin-market', 'installer-refused-unpublished-version', installer)
      const beforeRetry = registryReads
      const [retried] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/pluginManager/inspect', { timeout: 15_000 }),
        activate(installer.getByRole('button', { name: 'Retry', exact: true })),
      ])
      expect((await retried.json()), await installer.innerText()).toMatchObject({ result: { ok: true, value: { status: 'refused', problem: 'not-found' } } })
      await expect.poll(() => registryReads).toBeGreaterThan(beforeRetry)
      await installer.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 60_000 })
      await activate(installer.getByRole('button', { name: 'Close', exact: true }).last())
      expect(await detail.count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'plugin-market-browse'); throw error }
    finally { releaseIndex?.(); indexGate = undefined; await page.close() }
  }, 600_000)

  it('retains a readable listing on refresh failure, retries, and handles empty and invalid indexes', async () => {
    const { page, tripwire } = await open()
    const section = page.locator('[data-plugin-tab="discover"]')
    try {
      const addFirst = section.getByRole('button', { name: 'Add index source', exact: true })
      await section.locator('[data-market-entry]').first().or(addFirst).first().waitFor()
      if (await addFirst.count() > 0) {
        await activate(addFirst)
        const dialog = page.getByRole('dialog', { name: 'Index sources', exact: true })
        await dialog.getByRole('textbox', { name: 'Index URL', exact: true }).fill(`${origin}/index.json`)
        await activate(dialog.getByRole('button', { name: 'Add', exact: true }))
        await dialog.getByRole('button', { name: `Remove ${origin}/index.json`, exact: true }).waitFor()
        await activate(dialog.getByRole('button', { name: 'Close', exact: true }))
      }
      await section.locator('[data-market-entry]').first().waitFor()
      indexStatus = 503
      await activate(section.getByRole('button', { name: 'Refresh', exact: true }))
      await section.getByText('Could not read this index.', { exact: true }).waitFor()
      expect(await section.locator('[data-market-entry]').count()).toBeGreaterThan(0)
      await auditWorkflowState(page, 'plugin-market', 'refresh-failed-retains-listing', section)
      indexStatus = 200
      await activate(section.getByRole('button', { name: 'Retry', exact: true }))
      await section.getByRole('alert').waitFor({ state: 'hidden' })
      await auditWorkflowState(page, 'plugin-market', 'refresh-recovered', section)
      for (const variant of [
        { file: 'empty.json', state: 'empty-index', message: 'This index lists no plugins.' },
        { file: 'invalid.json', state: 'invalid-index', message: 'This index is not in a valid format.' },
      ]) {
        const dialog = await sources(page)
        await dialog.getByRole('textbox', { name: 'Index URL', exact: true }).fill(`${origin}/${variant.file}`)
        await activate(dialog.getByRole('button', { name: 'Add', exact: true }))
        await dialog.getByRole('button', { name: `Remove ${origin}/${variant.file}`, exact: true }).waitFor()
        await activate(dialog.getByRole('button', { name: 'Close', exact: true }))
        await section.getByText(variant.message, { exact: true }).waitFor()
        await auditWorkflowState(page, 'plugin-market', variant.state, section)
      }
      const dialog = await sources(page)
      const indexes = await invoke<Array<{ url: string; error?: string }>>('pluginMarket/listIndexes', {})
      const invalidError = indexes.find(index => index.url === `${origin}/invalid.json`)?.error
      if (invalidError === undefined) throw new Error('The invalid index must retain its Host read error')
      await dialog.getByText(invalidError, { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'sources-with-read-error', dialog)
      for (const file of ['invalid.json', 'empty.json', 'index.json']) {
        await activate(dialog.getByRole('button', { name: `Remove ${origin}/${file}`, exact: true }))
        await dialog.getByRole('button', { name: `Remove ${origin}/${file}`, exact: true }).waitFor({ state: 'hidden' })
      }
      await dialog.waitFor({ state: 'hidden' })
      await section.getByText('No plugin markets yet', { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'sources-removed', section)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'plugin-market-recovery'); throw error }
    finally { indexStatus = 200; await page.close() }
  }, 360_000)

  it('shows installed, provided and update states and follows exact-version exemption grants and revocations', async () => {
    const url = `${origin}/statuses.json`
    await invoke('pluginMarket/setIndexes', { urls: [url] })
    const query = { sort: { kind: 'index' }, offset: 0, limit: 50 }
    const original = await invoke<MarketSearchResult>('pluginMarket/search', { url, query })
    const listing = (name: string) => original.entries.find(entry => entry.name === name)
    expect(listing(INSTALLED)?.installation).toEqual({ status: 'installed', installedVersion: '1.0.0' })
    expect(listing(UPDATE)?.installation).toEqual({ status: 'update-available', installedVersion: '1.0.0' })
    expect(listing(DIFFERENT)?.installation).toEqual({ status: 'different-version', installedVersion: '3.0.0' })
    expect(listing(PROVIDED)?.installation).toEqual({ status: 'provided', installedVersion: providedVersion })
    const compatibility = listing(EXEMPT)?.versions[0]?.compatibility
    if (compatibility === undefined || compatibility.compatible) throw new Error('The exemption fixture must initially be incompatible')
    expect(compatibility.exempted).toBe(false)
    const runtimeVersion = compatibility.runtimeVersion
    const { page, tripwire } = await open()
    const section = page.locator('[data-plugin-tab="discover"]')
    const card = (name: string) => section.locator(`[data-market-entry="${name}"]`)
    const illustrationRequests = () => page.evaluate(() => performance.getEntriesByType('resource')
      .map(entry => new URL(entry.name).pathname.split('/').at(-1))
      .filter(name => name !== undefined && /^client\.(badge-skill|voice-input)-preview(?:\.zh)?\.js$/u.test(name)))
    const exemptionKey = `${EXEMPT}@1.0.0`
    const grants = async () => JSON.parse(await readFile(join(profileDir, 'compatibility.json'), 'utf8')) as Record<string, string[]>
    try {
      await expect.poll(() => section.locator('[data-market-entry]').count()).toBe(6)
      expect(await card(INSTALLED).getByRole('button', { name: 'View Installed acceptance bundle in Installed', exact: true }).innerText()).toBe('Installed')
      expect(await card(UPDATE).getByRole('button', { name: 'View Updatable acceptance bundle in Installed', exact: true }).innerText()).toBe('Update available')
      expect(await card(PROVIDED).getByRole('button', { name: 'View Shipped voice input in Installed', exact: true }).innerText()).toBe('Provided by DSH')
      expect(await card(DIFFERENT).getByRole('button', { name: 'View Different installed version in Installed', exact: true }).innerText()).toBe('Installed')
      expect(await card(BLOCKED).getByRole('button', { name: 'Install Incompatible without exemption', exact: true }).getAttribute('aria-disabled')).toBe('true')
      expect(await illustrationRequests()).toEqual([])
      await auditWorkflowState(page, 'plugin-market', 'installation-statuses', section)
      for (const entry of [
        { name: INSTALLED, title: 'Installed acceptance bundle', state: 'installed' },
        { name: UPDATE, title: 'Updatable acceptance bundle', state: 'update-available' },
        { name: PROVIDED, title: 'Shipped voice input', state: 'provided' },
        { name: DIFFERENT, title: 'Different installed version', state: 'different-version' },
      ]) {
        await activate(card(entry.name).getByRole('button', { name: `View ${entry.title}`, exact: true }))
        const detail = section.locator(`[data-market-detail="${entry.name}"]`)
        await detail.waitFor()
        const currentVersion = detail.locator('[data-market-version]').getByText('Installed', { exact: true })
        expect(await currentVersion.count()).toBe(entry.state === 'installed' || entry.state === 'provided' ? 1 : 0)
        if (entry.state === 'installed') {
          expectTextContrast(await captureTextContrast(page, [{ label: 'success', text: currentVersion }], 'market-installed-tag'))
        }
        await auditWorkflowState(page, 'plugin-market', `${entry.state}-detail`, detail)
        await activate(detail.getByRole('button', { name: `View ${entry.title} in Installed`, exact: true }))
        const installedDetail = page.locator(`[data-plugin-detail="${entry.name}"]`)
        await installedDetail.waitFor()
        if (entry.name === PROVIDED) {
          await installedDetail.getByRole('img', { name: /feature preview$/u }).waitFor()
          expect(await illustrationRequests()).toEqual(['client.voice-input-preview.js'])
        }
        await auditWorkflowState(page, 'plugin-market', `${entry.state}-installed-handoff`, installedDetail)
        await activate(installedDetail.getByRole('button', { name: 'Back to plugins', exact: true }))
        await activate(page.getByRole('tab', { name: 'Discover', exact: true }))
        await card(entry.name).waitFor()
      }
      await activate(card(EXEMPT).getByRole('button', { name: 'View Exact-version exemption', exact: true }))
      const detail = section.locator(`[data-market-detail="${EXEMPT}"]`)
      await detail.getByText('Incompatible', { exact: true }).waitFor()
      const install = detail.getByRole('button', { name: 'Install Exact-version exemption', exact: true })
      expect(await install.getAttribute('aria-disabled')).toBe('true')
      await auditWorkflowState(page, 'plugin-market', 'incompatible-version-detail', detail)
      await invoke('pluginManager/setVersionExemption', { packageVersion: exemptionKey, runtimeVersion, enabled: true, acceptRisk: true })
      expect((await grants())[exemptionKey]).toEqual([runtimeVersion])
      await detail.getByText('Exempted', { exact: true }).waitFor()
      expect(await install.getAttribute('aria-disabled')).toBeNull()
      expectTextContrast(await captureTextContrast(page, [
        { label: 'warning-tag', text: detail.getByText('Exempted', { exact: true }) },
        { label: 'warning-copy', text: detail.getByRole('note').locator('span') },
      ], 'market-exempted-version'))
      const exempted = await invoke<MarketSearchResult>('pluginMarket/search', { url, query })
      expect(exempted.entries.find(entry => entry.name === EXEMPT)?.versions[0]?.compatibility)
        .toMatchObject({ compatible: false, exempted: true })
      expect(exempted.entries.find(entry => entry.name === BLOCKED)?.versions[0]?.compatibility)
        .toMatchObject({ compatible: false, exempted: false })
      await auditWorkflowState(page, 'plugin-market', 'exempted-version-detail', detail)
      const before = registryReads
      await activate(install)
      const confirmation = page.getByRole('dialog', { name: 'Install "Exact-version exemption"?', exact: true })
      await confirmation.getByText('This version is not compatible with the running DSH, but you set a compatibility exemption for it.', { exact: true }).waitFor()
      await auditWorkflowState(page, 'plugin-market', 'exempted-installation-trust', confirmation)
      await activate(confirmation.getByRole('button', { name: 'Cancel', exact: true }))
      expect(registryReads).toBe(before)
      await invoke('pluginManager/setVersionExemption', { packageVersion: exemptionKey, runtimeVersion, enabled: false })
      expect((await grants())[exemptionKey]).toBeUndefined()
      await detail.getByText('Incompatible', { exact: true }).waitFor()
      expect(await install.getAttribute('aria-disabled')).toBe('true')
      await auditWorkflowState(page, 'plugin-market', 'exemption-revoked', detail)
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/plugin-market/exemption-revoked.expected.md'),
        (await detail.ariaSnapshot()).replaceAll(origin, '{{publisher}}').replaceAll(runtimeVersion, '{{runtime-version}}'), webSnapshotMode())
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'plugin-market-installation-status'); throw error }
    finally {
      try { await invoke('pluginManager/setVersionExemption', { packageVersion: exemptionKey, runtimeVersion, enabled: false }) }
      finally { await page.close() }
    }
  }, 360_000)

  it('installs the locally published market package in its private profile and enables it', async () => {
    const url = `${origin}/success.json`
    await invoke('pluginMarket/setIndexes', { urls: [url] })
    const { page, tripwire } = await open()
    const section = page.locator('[data-plugin-tab="discover"]')
    try {
      const card = section.locator(`[data-market-entry="${SUCCESS}"]`)
      await card.waitFor()
      await activate(card.getByRole('button', { name: `Install ${SUCCESS_TITLE}`, exact: true }))
      const confirmation = page.getByRole('dialog', { name: `Install "${SUCCESS_TITLE}"?`, exact: true })
      await activate(confirmation.getByRole('button', { name: 'Install', exact: true }))
      await expect.poll(() => existsSync(installReady), { timeout: 60_000 }).toBe(true)
      const installer = page.getByRole('dialog').filter({ has: page.locator('[data-install-phase]') })
      await installer.locator('[data-install-phase="running"]').waitFor()
      await auditWorkflowState(page, 'plugin-market', 'private-install-running', installer)
      await writeFile(installRelease, 'released')
      const settled = installer.locator('[data-install-phase="done"], [data-install-phase="failed"]')
      await settled.waitFor({ timeout: 90_000 })
      expect(await settled.getAttribute('data-install-phase'), await installer.innerText()).toBe('done')
      expect(tarballReads).toBeGreaterThan(0)
      const installedPath = join(profileDir, 'node_modules', SUCCESS)
      expect((await realpath(installedPath)).startsWith(profileDir + sep)).toBe(true)
      expect(JSON.parse(await readFile(join(installedPath, 'package.json'), 'utf8'))).toMatchObject({ name: SUCCESS, version: '1.0.0' })
      expect(existsSync(activationMarker)).toBe(false)
      await auditWorkflowState(page, 'plugin-market', 'private-install-complete', installer)
      await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/plugin-market/install-complete.expected.md'),
        (await installer.ariaSnapshot()).replaceAll(origin, '{{publisher}}').replaceAll(scratch, '{{private-installation}}'), webSnapshotMode())
      const [enabled] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/pluginManager/setBundleEnabled', { timeout: 60_000 }),
        activate(installer.getByRole('button', { name: 'Enable now', exact: true })),
      ])
      expect(enabled.ok()).toBe(true)
      expect(await enabled.json()).toMatchObject({ result: { ok: true, value: { changed: true, application: 'applied' } } })
      expect(existsSync(activationMarker)).toBe(true)
      await installer.waitFor({ state: 'hidden' })
      await activate(page.getByRole('tab', { name: 'Discover', exact: true }))
      await card.getByRole('button', { name: `View ${SUCCESS_TITLE} in Installed`, exact: true }).waitFor()
      const installed = await invoke<MarketSearchResult>('pluginMarket/search', { url, query: { sort: { kind: 'index' }, offset: 0, limit: 50 } })
      expect(installed.entries[0]?.installation).toEqual({ status: 'installed', installedVersion: '1.0.0' })
      await auditWorkflowState(page, 'plugin-market', 'newly-installed-listing', section)
      await activate(card.getByRole('button', { name: `View ${SUCCESS_TITLE} in Installed`, exact: true }))
      const detail = page.locator(`[data-plugin-detail="${SUCCESS}"]`)
      await detail.waitFor()
      await auditWorkflowState(page, 'plugin-market', 'newly-installed-handoff', detail)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) { await saveFailureShot(page, 'plugin-market-private-install'); throw error }
    finally {
      try { await writeFile(installRelease, 'released') }
      finally { await page.close() }
    }
  }, 360_000)
})
