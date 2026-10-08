/**
 * Assembled plugin approval: a real built `dsh --profile web` serving the
 * management page, the profile's real pinned pnpm, a file-source bundle whose
 * install script pnpm blocks, and the allow-and-retry path through the browser.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'
import { captureStableAria } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, saveFailureDom } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/plugin-install-approve', import.meta.url))
const MODE = webSnapshotMode()

function spawnSpec(argv: readonly string[], cwd: string, env?: Record<string, string>): SubprocessSpawnSpec {
  return {
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5_000,
    ...env === undefined ? {} : { env },
  }
}

const OUTPUT_LIMIT = 32 * 1024

function waitForOutput(child: SubprocessHandle, pattern: RegExp, label: string): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
    }
    const resolveOnce = (value: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveReady(value)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT)
      const match = pattern.exec(output)
      if (match === null) return
      resolveOnce(match[1] ?? match[0])
    }
    const timer = setTimeout(() => { rejectOnce(new Error(`${label} not ready:\n${output}`)) }, 60_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    void child.done.then((outcome) => {
      rejectOnce(new Error(`${label} exited before ready (${JSON.stringify(outcome)}):\n${output}`))
    }, (error: unknown) => {
      rejectOnce(new Error(`${label} failed before ready:\n${output}`, { cause: error }))
    })
  })
}

async function stopTree(child: SubprocessHandle): Promise<void> {
  child.terminate()
  const stopped = await child.waitForExit(AbortSignal.timeout(15_000))
  if (!stopped) throw new Error('process tree did not stop after termination escalation')
  await child.done
}

const ADDON = 'approval-fixture-addon'
const UNDECIDED = 'set this to true or false'

it('blocks a file-source install script, surfaces the pending key, and builds it after approval', async ({ signal }) => {
  const binPath = join(REPO_ROOT, 'apps/cli/lib/bin.js')
  if (!existsSync(binPath)) throw new Error('plugin approval test needs the built dsh bin; run pnpm run build first')
  // The profile's managed pnpm command resolves on PATH: the workspace's own
  // .bin entry is the repository-pinned distribution.
  const pnpmBin = join(REPO_ROOT, 'node_modules', '.bin')
  if (!existsSync(join(pnpmBin, 'pnpm'))) throw new Error('workspace pnpm is not installed; run pnpm install first')

  let host: SubprocessHandle | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let browserClose: Promise<void> | undefined
  const onAbort = (): void => {
    host?.terminate()
    if (browser !== undefined) {
      browserClose = browser.close()
      // Finally awaits this same promise and reports any close failure.
      void browserClose.catch(() => undefined)
    }
  }
  signal.addEventListener('abort', onAbort)
  // Canonical roots keep pnpm's source key independent of host tmpdir symlinks.
  const world = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-approve-')))
  const subprocessCtx = new Context()
  const failures: unknown[] = []
  try {
    const home = join(world, 'home')
    const profileDir = join(home, 'profiles', 'web')
    const addon = join(home, 'addon')
    const built = join(profileDir, 'node_modules', ADDON, 'built.txt')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'offline: true',
      `storeDir: ${join(world, 'store')}`,
      'strictDepBuilds: true',
      'allowBuilds:',
      '  kept: false',
      '',
    ].join('\n'))
    await mkdir(addon)
    await writeFile(join(addon, 'package.json'), JSON.stringify({
      name: ADDON, version: '1.0.0',
      scripts: { install: 'node build.cjs' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(addon, 'build.cjs'), 'require("node:fs").writeFileSync("built.txt", "built")\n')
    await writeFile(join(addon, 'cordis.patch.yml'), '[]\n')
    await mkdir(SNAPSHOT_DIR, { recursive: true })

    signal.throwIfAborted()
    await subprocessCtx.plugin(LocalSubprocessRuntime)
    signal.throwIfAborted()
    host = subprocessCtx.subprocess.spawn(spawnSpec(
      [process.execPath, binPath, '--profile', 'web', '--port', '0', '--no-open'],
      world,
      {
        ...process.env as Record<string, string>,
        PATH: `${pnpmBin}:${process.env.PATH ?? ''}`,
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(world, 'agents'),
        DEEPSEEK_API_KEY: 'keyless-approval-no-model-call',
        DSH_TELEMETRY_DISABLED: '1',
      },
    ))
    const baseUrl = await waitForOutput(host, /dsh web: (http:\/\/[^\s]+)/, 'built dsh web')

    signal.throwIfAborted()
    browser = await chromium.launch()
    signal.throwIfAborted()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    signal.throwIfAborted()
    try {
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(String(error)))
      await page.goto(baseUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: 'Add plugin', exact: true }).waitFor({ timeout: 15_000 })

      const install = page.getByRole('dialog', { name: 'Add plugin' })
      await panel.getByRole('button', { name: 'Add plugin', exact: true }).click()
      // The file: spec keeps pnpm's package-install path; a bare directory
      // links instead, and a link never runs install scripts.
      await install.getByRole('textbox').fill(`file:${addon}`)
      await install.getByRole('button', { name: 'Install', exact: true }).click()

      const dialog = page.getByRole('dialog')
      await dialog.getByText('The plugin could not be installed', { exact: true }).waitFor({ timeout: 90_000 })
      const blocked = dialog.locator('[data-install-approval]')
      await blocked.getByText('These packages have install scripts that pnpm did not run.', { exact: true }).waitFor()
      await blocked.getByText('Allow only packages you trust.', { exact: true }).waitFor()

      const blockedPolicy = parseYaml(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')) as
        { allowBuilds: Record<string, unknown> }
      expect(blockedPolicy.allowBuilds.kept).toBe(false)
      const undecided = Object.entries(blockedPolicy.allowBuilds)
        .filter(([key, value]) => key !== 'kept' && value === UNDECIDED)
        .map(([key]) => key)
      expect(undecided).toHaveLength(1)
      const pendingKey = undecided[0]!
      expect(pendingKey.startsWith(`${ADDON}@file:`)).toBe(true)
      expect(await realpath(resolve(profileDir, pendingKey.slice(`${ADDON}@file:`.length))), pendingKey).toBe(await realpath(addon))
      expect(pendingKey).not.toBe(ADDON)
      const items = blocked.getByRole('listitem')
      expect(await items.count()).toBe(1)
      expect(await items.first().textContent()).toBe(pendingKey)

      expect(existsSync(built)).toBe(false)
      const blockedManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(blockedManifest.dependencies?.[ADDON]).toBeUndefined()
      // Source identity is pinned above; goldens substitute only its temporary path.
      const fixtureSource = `${ADDON}@file:{{fixtureSource}}`
      const normalizedKey = pendingKey.replaceAll(world, '{{cwd}}')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'blocked.expected.md'),
        (await captureStableAria(page, '[role="dialog"]', world)).replaceAll(normalizedKey, fixtureSource), MODE)

      await blocked.getByRole('button', { name: 'Allow these scripts and retry', exact: true }).click()
      await dialog.getByText(`Install scripts allowed for ${pendingKey}`, { exact: true }).waitFor({ timeout: 90_000 })
      await dialog.getByText('Installed', { exact: true }).waitFor()
      expect(await readFile(built, 'utf8')).toBe('built')
      const approvedPolicy = parseYaml(await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')) as
        { allowBuilds: Record<string, unknown> }
      expect(approvedPolicy.allowBuilds[pendingKey]).toBe(true)
      expect(approvedPolicy.allowBuilds.kept).toBe(false)
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dependencies[ADDON]).toMatch(/^file:/u)
      expect(manifest.dsh.profile.bundles).not.toContain(ADDON)
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'approved.expected.md'),
        (await captureStableAria(page, '[role="dialog"]', world)).replaceAll(normalizedKey, fixtureSource), MODE)
      expect(pageErrors).toEqual([])
    } catch (error) {
      await saveFailureShot(page, 'plugin-install-approve')
      await saveFailureDom(page, 'plugin-install-approve')
      try {
        await writeFile('.artifacts/plugin-install-approve-dialog.md', `${await page.locator('[role="dialog"]').ariaSnapshot()}\n`)
        await writeFile('.artifacts/plugin-install-approve-world.txt', [
          `profileDir: ${profileDir}`,
          `pnpm-workspace.yaml:\n${await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8').catch(String)}`,
          `package.json:\n${await readFile(join(profileDir, 'package.json'), 'utf8').catch(String)}`,
        ].join('\n'))
      } catch { /* failure evidence is best-effort */ }
      throw error
    }
  } catch (error) {
    failures.push(error)
  } finally {
    signal.removeEventListener('abort', onAbort)
    const closing = browserClose ?? browser?.close()
    if (closing !== undefined) await closing.catch((error: unknown) => failures.push(error))
    if (host !== undefined) await stopTree(host).catch((error: unknown) => failures.push(error))
    await subprocessCtx.fiber.dispose().catch((error: unknown) => failures.push(error))
    await rm(world, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'plugin approval test or cleanup failed')
}, 180_000)

it('owns the plugin approval goldens', async () => {
  expect((await readdir(SNAPSHOT_DIR)).sort()).toEqual(['approved.expected.md', 'blocked.expected.md'])
})
