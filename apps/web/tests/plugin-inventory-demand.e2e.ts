/** Runtime management and full preset inventory through the shipped Web composition. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/plugin-inventory-demand/preset.expected.md', import.meta.url))

it('reads preset compositions only when the full inventory is opened', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-plugin-inventory-demand-'))
  const owned: { browser?: Browser; scaffold?: WebScaffold } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  })
  const presetRoot = join(scratch, 'presets')
  const preset = join(presetRoot, 'inventory-probe')
  const probe = join(scratch, 'evaluations.txt')
  await mkdir(preset, { recursive: true })
  await writeFile(probe, '')
  // A synchronous file append observes the real Loader expression before its RPC settles.
  const expression = `(process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(probe)}, 'x'), false)`
  await writeFile(join(preset, 'agent.cordis.yml'), [
    '- id: inventory-probe-todo',
    "  name: '@deepseek-ai/dsh-tool-todo'",
    '  disabled: !!js >-',
    `    ${expression}`,
    '',
  ].join('\n'))
  await writeFile(join(preset, 'preset.yml'), 'name: Inventory probe\n')
  const scaffold = await launchWebScaffold({
    agentPresets: {
      roots: [{ path: SHIPPED_PRESETS, trust: 'system' }, { path: presetRoot, trust: 'user' }],
      default: 'standard',
    },
  })
  owned.scaffold = scaffold
  const browser = await chromium.launch()
  owned.browser = browser
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'plugin-inventory-demand'))
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('navigation', { name: '面板' }).waitFor()
  const before = (await readFile(probe, 'utf8')).length
  await page.getByRole('navigation', { name: '面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  await panel.getByRole('button', { name: '查看 终端', exact: true }).waitFor()
  expect((await readFile(probe, 'utf8')).length).toBe(before)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '内置插件', exact: true }).click()
  const switcher = dialog.getByRole('button', { name: '选择要查看的 Agent 预设', exact: true })
  await switcher.waitFor()
  expect((await readFile(probe, 'utf8')).length).toBeGreaterThan(before)
  await switcher.click()
  await page.getByRole('menuitem', { name: 'Inventory probe', exact: true }).click()
  const scope = dialog.locator('[data-plugin-scope="preset"][data-preset-id="inventory-probe"]')
  await scope.locator('[data-plugin-entry="inventory-probe-todo"]').waitFor()
  expect(await scope.getByRole('alert').count()).toBe(0)
  await compareOrRefreshGolden(EXPECTED,
    await captureStableAria(page, '[data-plugin-scope="preset"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  expect(await page.locator('[data-slot-error]').count()).toBe(0)
})
