/**
 * Operator visual audit for compact product chrome. Writes screenshots under
 * `.playwright-mcp/compact-chrome/` — not a committed golden lane.
 *
 * Seeds the navigation-panes fixture so Chat, tool rows, Trajectory, and the
 * event-details overlay exist without a live model turn. The settings pass
 * also captures the same compact surface under the shipped dark palette so a
 * visual audit does not rely on token/color assertions alone. Run after
 * `pnpm run build:lib:client && pnpm run build:web`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const OUT = fileURLToPath(new URL('../../../.playwright-mcp/compact-chrome/', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/navigation-panes/seed.jsonl', import.meta.url))
const SEED_ID = 'navigation-panes-web-e2e'

const PHONES = [
  { tag: '390x844', width: 390, height: 844 },
  { tag: '375x667', width: 375, height: 667 },
  { tag: '320x568', width: 320, height: 568 },
] as const

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
}

async function dumpOverflow(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const small = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
      .map((el) => {
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) return null
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null
        // Virtualized trajectory rows may retain a focusable marker just
        // outside the feed's own clipping edge; that is intentional and not
        // viewport overflow.
        const feed = el.closest<HTMLElement>('[data-trajectory-feed]')
        if (feed !== null) {
          const feedBox = feed.getBoundingClientRect()
          if (box.bottom <= feedBox.top || box.top >= feedBox.bottom) return null
        }
        const onScreen = box.right > 1 && box.left < vw - 1 && box.bottom > 1 && box.top < vh - 1
        if (!onScreen) return null
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
        return {
          label,
          w: Math.round(box.width),
          h: Math.round(box.height),
          clipped: box.right > vw + 1 || box.bottom > vh + 1 || box.left < -1 || box.top < -1,
        }
      })
      .filter(row => row !== null)
    return {
      viewport: {
        vw,
        vh,
        stamp: document.querySelector('[data-viewport]')?.getAttribute('data-viewport'),
      },
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
      dsw: getComputedStyle(document.documentElement).getPropertyValue('--dsw-viewport-height'),
      tiny: small.filter(row => row.h < 40 && row.w < 40).slice(0, 20),
      clipped: small.filter(row => row.clipped).slice(0, 16),
      dialog: (() => {
        const dialog = document.querySelector('[role="dialog"]')
        if (dialog === null) return null
        const box = dialog.getBoundingClientRect()
        return { x: box.x, y: box.y, w: box.width, h: box.height }
      })(),
      stats: (() => {
        const stats = document.querySelector<HTMLElement>('[data-stats-line]')
        if (stats === null) return null
        const box = stats.getBoundingClientRect()
        return {
          top: Math.round(box.top), bottom: Math.round(box.bottom), h: Math.round(box.height),
          viewportGap: Math.round(vh - box.bottom),
        }
      })(),
    }
  })
}

async function dismissOnboarding(page: Page): Promise<void> {
  const welcome = page.locator('[class*="onboardingOverlay"]')
  if (await welcome.count() > 0) {
    await welcome.getByRole('button').first().click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
  }
}

async function openDrawer(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /打开侧边栏|Open sidebar/ })
  if (await toggle.count() === 0) return
  const expanded = await toggle.getAttribute('aria-expanded')
  if (expanded !== 'true') await toggle.click()
  const drawer = page.locator('[class*="drawer"]').first()
  await drawer.getByRole('button', { name: /^设置$|^Settings$/ }).waitFor({ timeout: 10_000 })
  // The visibility flag flips at the beginning of the shell transition; wait
  // for the drawer edge itself before capturing or interacting with its rows.
  await expect.poll(
    () => drawer.evaluate(element => Math.round(element.getBoundingClientRect().x)),
    { timeout: 2_000 },
  ).toBe(0)
}

async function closeDrawer(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /关闭侧边栏|Close sidebar|打开侧边栏|Open sidebar/ })
  if (await toggle.count() === 0) return
  if (await toggle.getAttribute('aria-expanded') === 'true') {
    await toggle.click()
    const drawer = page.locator('[class*="drawer"]').first()
    await expect.poll(
      () => drawer.evaluate(element => Math.round(element.getBoundingClientRect().right)),
      { timeout: 2_000 },
    ).toBeLessThanOrEqual(0)
  }
}

async function openSeededChat(page: Page): Promise<void> {
  await openDrawer(page)
  await page.getByText(/未分组|Ungrouped/, { exact: true }).waitFor({ timeout: 30_000 })
  const searchButton = page.getByRole('button', { name: /搜索会话|Search sessions/ })
  if (await searchButton.count() > 0 && await searchButton.getAttribute('aria-expanded') !== 'true') {
    await searchButton.click()
  }
  const search = page.getByPlaceholder(/搜索会话|Search sessions/)
  await search.waitFor({ timeout: 10_000 })
  await search.fill('WATERFALL')
  const result = page.getByRole('tree', { name: /搜索结果|Search results/ }).getByRole('treeitem')
  await result.first().waitFor({ timeout: 30_000 })
  await result.first().click()
  await page.getByText('FIRST_DONE', { exact: true }).waitFor({ timeout: 15_000 })
  await closeDrawer(page)
  const chat = page.getByRole('tab', { name: /对话|Chat/, exact: true })
  if (await chat.count() > 0) await chat.click()
}

describe('visual audit: compact product chrome', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true })
    scaffold = await launchWebScaffold({})
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'nav-a.md'), '# alpha nav\n')
    await writeFile(join(sessionCwd, 'nav-b.md'), '# beta nav\n')
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SEED_ID)
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('covers landing, seeded chat, trajectory, settings, and documents on phones', async () => {
    const findings: Record<string, unknown> = {}
    // The visual audit is a keyless, cross-platform fixture. Native opener
    // availability varies by runner, so keep this lane focused on browser
    // geometry; seeded-history covers the refusal dialog separately.
    const openPath = vi.spyOn(scaffold.ctx.apiProxy.host, 'openPath')
      .mockImplementation(async (request, _signal) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { opened: true as const } },
      }))

    try {
      for (const phone of PHONES) {
        const prefix = phone.tag
        const page: Page = await browser.newPage({
          viewport: { width: phone.width, height: phone.height },
          locale: ZH_BROWSER_LOCALE,
          hasTouch: true,
          isMobile: true,
        })
        await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
        await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
        await dismissOnboarding(page)
        await shot(page, `${prefix}-00-landing`)
        if (phone.width <= 359) {
          expect(await page.locator('[data-session-summary]').count()).toBe(0)
        }
        findings[`${prefix}.landing`] = await dumpOverflow(page)

        const pickWorkspace = page.getByRole('button', { name: /选择工作区|Choose workspace/ })
        if (await pickWorkspace.count() > 0) {
          await pickWorkspace.click()
          const addWorkspace = page.getByRole('menuitem', { name: /添加工作区|Add workspace/ })
          // The workspace baseline may still be loading, so the compact picker
          // can expose its explicit add row before the directory flow opens.
          if (await addWorkspace.count() > 0) {
            await addWorkspace.first().click()
          }
          await page.getByRole('dialog').waitFor({ timeout: 10_000 })
          await page.waitForTimeout(300)
          await shot(page, `${prefix}-01-workspace-dialog`)
          findings[`${prefix}.workspaceDialog`] = await dumpOverflow(page)
          await page.keyboard.press('Escape')
        }

        const preset = page.getByRole('button', { name: /标准模式|Standard/ })
        if (await preset.count() > 0) {
          await preset.click()
          await page.waitForTimeout(300)
          await shot(page, `${prefix}-02-preset-menu`)
          findings[`${prefix}.presetMenu`] = await dumpOverflow(page)
          await page.keyboard.press('Escape')
        }

        await openSeededChat(page)
        await shot(page, `${prefix}-03-chat`)
        findings[`${prefix}.chat`] = await dumpOverflow(page)
        if (phone.width <= 359) {
          const shellToggle = page.locator('[class*="topbarToggle"]').first()
          const shellToggleBox = await shellToggle.boundingBox()
          if (shellToggleBox === null) throw new Error('compact topbar toggle has no geometry')
          expect(shellToggleBox.x).toBeGreaterThanOrEqual(0)
          expect(shellToggleBox.x + shellToggleBox.width).toBeLessThanOrEqual(phone.width + 1)
        }
        await page.getByRole('heading', { name: 'Navigation Summary' }).waitFor({ timeout: 10_000 })
        await shot(page, `${prefix}-04-chat-markdown`)

        const toolRow = page.locator('[data-tool], [class*="ToolRow"]').first()
        if (await toolRow.count() > 0) {
          await toolRow.click()
          await page.waitForTimeout(300)
          await shot(page, `${prefix}-05-tool-expanded`)
          findings[`${prefix}.tool`] = await dumpOverflow(page)
        }

        const commands = page.getByRole('button', { name: '命令' })
        if (await commands.count() > 0) {
          await commands.click()
          await page.waitForTimeout(300)
          await shot(page, `${prefix}-06-composer-commands`)
          findings[`${prefix}.commands`] = await dumpOverflow(page)
          await page.keyboard.press('Escape')
        }

        const model = page.locator('[data-composer-card] button[aria-haspopup="menu"]').last()
        if (await model.count() > 0) {
          await model.click()
          await page.waitForTimeout(300)
          const sessionSheet = page.locator('[data-session-settings-sheet]')
          if (await sessionSheet.count() > 0) {
            const toBottom = page.getByRole('button', { name: /回到底部|Back to bottom/ })
            if (await toBottom.count() > 0 && await toBottom.isVisible()) {
              const covered = await toBottom.evaluate((button) => {
                const box = button.getBoundingClientRect()
                const point = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
                return point?.closest('[data-session-settings-sheet]') !== null
              })
              expect(covered, `${prefix}: session sheet must cover back-to-bottom control`).toBe(true)
            }
          }
          await shot(page, `${prefix}-07-model-menu`)
          findings[`${prefix}.model`] = await dumpOverflow(page)
          await page.keyboard.press('Escape')
        }

        await page.getByRole('tab', { name: /轨迹|Trajectory/ }).click()
        await page.locator('[data-trajectory-feed], table, [role="table"]').first().waitFor({ timeout: 15_000 })
        await page.waitForTimeout(400)
        await shot(page, `${prefix}-08-trajectory`)
        findings[`${prefix}.trajectory`] = await dumpOverflow(page)

        const toolEvent = page.locator('[data-trajectory-feed] [data-kind="tool"], tr[data-kind="tool"]').first()
        if (await toolEvent.count() > 0) {
          await toolEvent.click()
          const details = page.locator('[data-trajectory-details]').first()
          await details.waitFor({ timeout: 10_000 })
          if (phone.width < 768) {
            expect(await details.getAttribute('role')).toBe('dialog')
            expect(await details.getAttribute('aria-modal')).toBe('true')
          }
          await page.waitForTimeout(300)
          await shot(page, `${prefix}-09-event-details`)
          findings[`${prefix}.eventDetails`] = await dumpOverflow(page)
          if (phone.width <= 359) {
            // Short phones must retain the first summary value; a flex-shrunk
            // nested overview used to leave only section headings visible.
            expect(await details.getByText('Completed', { exact: true }).count()).toBe(1)
          }
          const closeDetails = details.getByRole('button', { name: /Close details|关闭详情/ })
          if (await closeDetails.count() > 0) await closeDetails.click()
          else await page.keyboard.press('Escape')
        }

        await openDrawer(page)
        await shot(page, `${prefix}-10-drawer`)
        findings[`${prefix}.drawer`] = await dumpOverflow(page)

        await page.getByRole('button', { name: '设置', exact: true }).click()
        try {
          await page.getByRole('dialog').waitFor({ timeout: 8_000 })
          await page.waitForTimeout(400)
          await shot(page, `${prefix}-11-settings`)
          findings[`${prefix}.settings`] = await dumpOverflow(page)
          const modelsTab = page.getByRole('dialog').getByRole('button', { name: '模型', exact: true })
          if (await modelsTab.count() > 0) {
            await modelsTab.click()
            await page.waitForTimeout(400)
            await shot(page, `${prefix}-12-settings-models`)
            findings[`${prefix}.settingsModels`] = await dumpOverflow(page)
          }
          // Keep one real dark-palette capture for every compact size. The
          // attribute is the same presenter contract used by ThemeRuntime;
          // removing it before the next surface keeps the audit independent.
          await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
          await page.waitForTimeout(100)
          await shot(page, `${prefix}-12-settings-dark`)
          findings[`${prefix}.settingsDark`] = await dumpOverflow(page)
          await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
          await page.keyboard.press('Escape')
        } catch {
          findings[`${prefix}.settings`] = 'no dialog'
        }

        await openDrawer(page)
        const documents = page.getByRole('button', { name: '文档', exact: true })
        if (await documents.count() > 0) {
          await documents.click()
          try {
            await page.getByRole('dialog').waitFor({ timeout: 8_000 })
            await page.waitForTimeout(300)
            await shot(page, `${prefix}-13-documents`)
            findings[`${prefix}.documents`] = await dumpOverflow(page)
            if (phone.width <= 359) {
              const toolbar = page.getByRole('dialog').locator('[class*="toolbar"]').first()
              const newFolder = toolbar.getByRole('button', { name: /新建文件夹|New folder/ })
              const upload = toolbar.getByRole('button', { name: /上传文档|Upload documents/ })
              const refresh = toolbar.getByRole('button', { name: /刷新|Refresh/ })
              const boxes = await Promise.all([newFolder, upload, refresh].map(control => control.boundingBox()))
              if (boxes.some(box => box === null)) throw new Error('compact document toolbar geometry missing')
              expect(new Set(boxes.map(box => Math.round(box!.y))).size).toBe(1)
              expect(boxes.every(box => box!.x >= 0 && box!.x + box!.width <= phone.width + 1)).toBe(true)
            }
            await page.keyboard.press('Escape')
          } catch {
            findings[`${prefix}.documents`] = 'no dialog'
          }
        }

        await page.close()
      }
    } finally {
      openPath.mockRestore()
    }

    writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`)
  }, 360_000)
})
