// Web e2e scenario: switching models in the composer is how this deployment's
// default is chosen. The gesture writes the shared `agent-default-model` settings section, a
// session created afterwards starts from it, and a session that already logged
// a route keeps deriving from its own log — the tier order the gateway
// resolves on every read.
// Zero model calls: the switch is settings/llm-domain traffic only, so there
// is no fixture and a stray stream would fail loud because the adapter registry is empty. Both
// routes are declared host-side (not through the UI, which has its own
// scenario) through the pi-ai adapter the shipped tree already mounts: a
// fixture-less scaffold registers no adapter at all, so the routes the
// picker offers — and the one the composer must start on — have to come from
// somewhere, and settings profiles are the product's own way to add them.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Points the shipped shared Agent default at this scenario's own route. */
const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))

/** The route this scenario starts on, patched over the shipped default. */
const START_ROUTE = 'origin-gateway'
const START_MODEL = 'origin-large'
/** The route the switch lands on, which then becomes the saved default. */
const ROUTE = 'acme-gateway'
const MODEL = 'acme-large'

/** The composer text field, a plain textarea in this deployment. */
const composerInput = (page: Page): Locator => page.locator('textarea[data-input-phase], textarea').first()

describe('web e2e: the composer model switch is the default for later sessions', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /** Create one session and its agent through the same wire face the browser uses. */
  const createSession = async (sessionId: string): Promise<string> => {
    const response = await scaffold.ctx.apiProxy.sessions.create({
      rpcId: `default-model-create-${sessionId}` as never,
      payload: { sessionId: SessionId(sessionId), cwd: scaffold.workspaceCwd },
    })
    if (!response.result.ok) throw new Error(`session.create failed: ${response.result.error.message}`)
    return response.result.value.sessionId
  }

  /** The route the gateway reports for one session, through the real wire face. */
  const currentOf = async (sessionId: string): Promise<unknown> => {
    const response = await scaffold.ctx.apiProxy.sessions.models({
      rpcId: `default-model-${sessionId}` as never,
      payload: { sessionId: SessionId(sessionId) },
    })
    if (!response.result.ok) throw new Error(`session.models failed: ${response.result.error.message}`)
    return response.result.value.current
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    // Two routes so the picker has somewhere to start and somewhere to go.
    // Declared through the settings seam rather than the Models page: this
    // scenario is about the composer, and the declaring flow is covered by
    // models-settings.e2e.
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        [START_ROUTE]: {
          displayName: 'Origin Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.origin.example/v1',
          models: [{ id: START_MODEL, name: 'Origin Large' }],
        },
        [ROUTE]: {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: MODEL, name: 'Acme Large' }, { id: 'acme-small', name: 'Acme Small' }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The composer's seats only exist once a workspace is connected: without
    // one the input is the locked placeholder and no session scope is open.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps command popup search borders transparent in both palettes', async () => {
    const composer = composerInput(page)
    await composer.pressSequentially('/')
    const commandMenuBounds = await page.locator('[data-trigger-menu]').boundingBox()
    await page.getByRole('option', { name: /^模型/ }).click()
    const search = page.getByRole('textbox', { name: '筛选选项', exact: true })
    await search.waitFor()
    try {
      const popupBounds = await page.locator('[aria-label="/model 选项"]').boundingBox()
      expect(popupBounds).not.toBeNull()
      expect(commandMenuBounds).not.toBeNull()
      // This popup sizes to its own content under max-width:100% of the
      // composer card; the alignment contract is the shared left edge.
      expect(popupBounds!.width).toBeLessThanOrEqual(commandMenuBounds!.width)
      expect(popupBounds!.x).toBeCloseTo(commandMenuBounds!.x)
      expect(await search.getAttribute('placeholder')).toBe('搜索模型…')
      await page.getByRole('option').first().waitFor()
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./snapshots/default-model/command-picker.expected.md', import.meta.url)),
        await captureStableAria(page, '[aria-label="/model 选项"]', scaffold.workspaceCwd),
        webSnapshotMode(),
      )
      await search.fill('no-model-matches')
      await page.getByText('没有匹配的模型。', { exact: true }).waitFor()
      await search.fill('')
      const borders = await search.evaluate((input) => {
        const body = input.ownerDocument.body
        const previousTheme = body.getAttribute('data-ds-dark-theme')
        try {
          return [false, true].map((dark) => {
            body.toggleAttribute('data-ds-dark-theme', dark)
            return getComputedStyle(input).borderColor
          })
        } finally {
          if (previousTheme === null) body.removeAttribute('data-ds-dark-theme')
          else body.setAttribute('data-ds-dark-theme', previousTheme)
        }
      })
      expect(borders).toEqual(['rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.06)'])
    } finally {
      await search.press('Escape')
      await composer.fill('')
    }
  })

  it('shares provider order, fuzzy result order and sticky header material between both model pickers', async () => {
    const readGroups = (surface: Locator, role: 'option' | 'menuitemradio') => surface.locator('[data-menu-group]')
      .evaluateAll((groups, rowRole) => groups.map(group => ({
        label: group.querySelector('[data-menu-group-heading]')!.textContent,
        // The seat picker appends capability copy; the option popup may append
        // a badge. Compare the inner name cell both surfaces share.
        rows: [...group.querySelectorAll(`[role="${rowRole}"]`)].map(row =>
          row.querySelector('span span')?.textContent),
      })), role)
    const checkSticky = async (surface: Locator, viewport: Locator) => {
      // Bound only this test's list viewport so native scrolling can cross a heading.
      await viewport.evaluate((node) => { node.style.maxHeight = '80px'; node.scrollTop = 0 })
      const heading = surface.locator('[data-menu-group-heading]').first()
      await expect.poll(() => heading.getAttribute('data-stuck')).toBeNull()
      const clear = await heading.evaluate(node => getComputedStyle(node).backgroundColor)
      expect(clear).toBe('rgba(0, 0, 0, 0)')
      await viewport.evaluate((node) => { node.scrollTop = 10 })
      await expect.poll(() => heading.getAttribute('data-stuck')).toBe('')
      const stuck = await heading.evaluate((node) => {
        const style = getComputedStyle(node)
        return { fill: style.backgroundColor, radius: style.borderRadius, font: style.fontSize, padding: style.padding }
      })
      await viewport.evaluate((node) => { node.scrollTop = 0 })
      await expect.poll(() => heading.getAttribute('data-stuck')).toBeNull()
      return stuck
    }
    try {
      await page.getByRole('button', { name: /^选择模型/ }).click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      const menu = page.getByRole('group', { name: '模型与推理等级', exact: true })
      const menuSearch = page.getByRole('searchbox', { name: '搜索模型…' })
      const order = await readGroups(menu, 'menuitemradio')
      const sticky = await checkSticky(menu, menu.getByRole('menu', { name: '模型', exact: true }))
      await menuSearch.fill('  ACMLG  ')
      const filtered = await readGroups(menu, 'menuitemradio')
      await menuSearch.press('Escape')
      await page.keyboard.press('Escape')
      await composerInput(page).pressSequentially('/')
      await page.getByRole('option', { name: /^模型/ }).click()
      const popup = page.locator('[aria-label="/model 选项"]')
      await popup.getByRole('option').first().waitFor()
      expect(await readGroups(popup, 'option')).toEqual(order)
      expect(await checkSticky(popup, popup.getByRole('listbox'))).toEqual(sticky)
      const popupSearch = page.getByRole('textbox', { name: '筛选选项', exact: true })
      await popupSearch.fill('  ACMLG  ')
      expect(await readGroups(popup, 'option')).toEqual(filtered)
      expect(await popupSearch.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await composerInput(page).fill('')
    }
  })

  it('hides search only in the button menu when four models remain', async () => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const search = page.getByRole('searchbox', { name: '搜索模型…' })
    const setModels = (expanded: boolean) => scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: { [ROUTE]: {
        displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://gateway.acme.example/v1',
        models: expanded ? [{ id: MODEL, name: 'Acme Large' }, { id: 'acme-small', name: 'Acme Small' }]
          : [{ id: MODEL, name: 'Acme Large' }],
      } },
    })
    try {
      await setModels(false)
      await trigger.click()
      await page.getByRole('menuitem', { name: /模型/ }).click()
      await expect.poll(() => page.getByRole('menuitemradio').count()).toBe(4)
      expect(await search.count()).toBe(0)
      const current = page.getByRole('menuitemradio', { name: /^Origin Large/ })
      await expect.poll(() => current.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      const rows = page.getByRole('menuitemradio')
      const currentId = await current.getAttribute('id')
      for (let index = 0; index < 4; index++) await page.keyboard.press('ArrowDown')
      expect(await page.evaluate(() => document.activeElement?.id)).toBe(currentId)
      await page.keyboard.press('Enter')
      await expect.poll(() => trigger.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true)
      // Focused trigger carries the design's focus ring, not an open-menu glow.
      expect(await trigger.evaluate(node => getComputedStyle(node).boxShadow)).toBe('rgba(0, 0, 0, 0.12) 0px 0px 0px 2px')
      await composerInput(page).pressSequentially('/')
      await page.getByRole('option', { name: /^模型/ }).click()
      const commandSearch = page.getByRole('textbox', { name: '筛选选项', exact: true })
      await commandSearch.waitFor()
      expect(await commandSearch.getAttribute('placeholder')).toBe('搜索模型…')
      await commandSearch.press('Escape')
      await composerInput(page).fill('')
      expect(await rows.count()).toBe(0)
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await setModels(true)
      await trigger.click()
      await page.getByRole('menuitem', { name: /模型/ }).click()
      await expect.poll(() => page.getByRole('menuitemradio').count()).toBe(5)
      await search.waitFor()
      await search.press('Escape')
      await page.keyboard.press('Escape')
    }
  })

  it('paints only pinned provider headings across themes, filtering, and reopening', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-sticky-headings'))
    const originalViewport = page.viewportSize()!
    const attributes = await page.evaluate(() => ({
      platform: document.documentElement.getAttribute('data-platform'),
      theme: document.body.getAttribute('data-ds-dark-theme'),
    }))
    const surface = page.getByRole('group', { name: '模型与推理等级', exact: true })
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    const search = page.getByRole('searchbox', { name: '搜索模型…' })
    try {
      await page.setViewportSize({ width: 1680, height: 220 })
      await trigger.click()
      await page.getByRole('menuitem', { name: /模型/ }).click()
      const scroller = page.getByRole('menu', { name: '模型', exact: true })
      const headings = surface.locator('section[role="group"] > div')
      const readPinned = () => headings.evaluateAll(nodes => nodes.map(node => node.hasAttribute('data-stuck')))
      const resetScroll = async (): Promise<void> => {
        await scroller.evaluate((node) => { node.scrollTop = 0 })
        await expect.poll(readPinned).toEqual([false, false, false])
      }
      for (const platform of ['web', 'win32', 'darwin']) {
        for (const dark of [false, true]) {
          await page.evaluate(({ platform, dark }) => {
            if (platform === 'web') document.documentElement.removeAttribute('data-platform')
            else document.documentElement.setAttribute('data-platform', platform)
            document.body.toggleAttribute('data-ds-dark-theme', dark)
          }, { platform, dark })
          await resetScroll()
          expect(await headings.evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).backgroundColor))]))
            .toEqual(['rgba(0, 0, 0, 0)'])
          const secondTop = await scroller.evaluate((node) => {
            const second = node.querySelectorAll('section')[1]!
            return Math.ceil(second.getBoundingClientRect().top - node.getBoundingClientRect().top) + 1
          })
          expect(await scroller.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThanOrEqual(secondTop)
          await scroller.evaluate((node) => { node.scrollTop = 10 })
          await expect.poll(readPinned).toEqual([true, false, false])
          expect(await headings.first().evaluate(node => getComputedStyle(node).backgroundColor))
            .toBe(dark ? 'rgba(53, 54, 56, 0.94)' : 'rgba(255, 255, 255, 0.94)')
          await scroller.evaluate((node, top) => { node.scrollTop = top }, secondTop)
          await expect.poll(readPinned).toEqual([false, true, false])
          await scroller.evaluate((node) => { node.scrollTop = 10 })
          await expect.poll(readPinned).toEqual([true, false, false])
          await resetScroll()
        }
      }
      await scroller.evaluate((node) => { node.scrollTop = 10 })
      await expect.poll(readPinned).toEqual([true, false, false])
      await search.fill('Origin Large')
      await expect.poll(() => headings.count()).toBe(1)
      await expect.poll(readPinned).toEqual([false])
      await page.getByRole('button', { name: '清除搜索', exact: true }).click()
      await expect.poll(readPinned).toEqual([false, false, false])
      await search.fill('zzzz')
      await expect.poll(() => surface.locator('[data-stuck]').count()).toBe(0)
      await page.getByRole('button', { name: '清除搜索', exact: true }).click()
      await expect.poll(readPinned).toEqual([false, false, false])
      await search.press('Escape')
      await page.keyboard.press('Escape')
      await trigger.click()
      await page.getByRole('menuitem', { name: /模型/ }).click()
      expect(await search.inputValue()).toBe('')
      await resetScroll()
    } finally {
      if (await surface.count()) await search.press('Escape')
      if (await trigger.getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
      await page.setViewportSize(originalViewport)
      await page.evaluate(({ platform, theme }) => {
        if (platform === null) document.documentElement.removeAttribute('data-platform')
        else document.documentElement.setAttribute('data-platform', platform)
        if (theme === null) document.body.removeAttribute('data-ds-dark-theme')
        else document.body.setAttribute('data-ds-dark-theme', theme)
      }, attributes)
    }
  })

  it('writes the switched model as the default and leaves a logged session alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model'))
    // A session that has already run a turn, spelled as the fact a turn
    // leaves behind: its own logged route.
    const loggedId = await createSession('default-model-logged')
    scaffold.ctx.sessions.get(SessionId(loggedId))?.append('request/header', {
      header: { config: { provider: START_ROUTE, model: START_MODEL } },
      reason: 'initial',
    })

    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    expect(await trigger.evaluate(element => getComputedStyle(element).fontWeight)).toBe('500')
    await trigger.click()
    const modelMenuBounds = await page.getByRole('menu', { name: '模型与推理等级', exact: true }).boundingBox()
    const composerBounds = await page.locator('[data-composer-card]').first().boundingBox()
    expect(modelMenuBounds!.width).toBeLessThan(composerBounds!.width)
    const modelCell = page.getByRole('menuitem', { name: /模型/ })
    await trigger.press('ArrowDown')
    expect(await modelCell.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    expect(await modelCell.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('auto')
    const focusedBackground = await modelCell.evaluate(element => getComputedStyle(element).backgroundColor)
    expect(focusedBackground).not.toBe('')
    await trigger.focus()
    await modelCell.hover()
    // Hovering a row while the trigger holds focus must not collapse the menu.
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    await modelCell.click()
    const search = page.getByRole('searchbox', { name: '搜索模型…' })
    const rowIds = await page.getByRole('menuitemradio').evaluateAll(rows => rows.map(row => row.id))
    const initialHighlight = rowIds.indexOf(await search.getAttribute('aria-activedescendant') ?? '')
    expect(initialHighlight).toBeGreaterThanOrEqual(0)
    for (let step = 1; step <= rowIds.length + 1; step++) {
      await search.press('ArrowDown')
      expect(await search.getAttribute('aria-activedescendant')).toBe(rowIds[(initialHighlight + step) % rowIds.length])
    }
    const searchStyle = await search.evaluate((input) => {
      const caption = input.ownerDocument.createElement('div')
      caption.textContent = 'No matching models.'
      // Placeholder copy rides the muted-label token, like the menu's own
      // secondary text — a probe element resolves the same token.
      caption.style.color = 'var(--dsw-alias-label-caption)'
      const wrapper = input.parentElement!
      wrapper.append(caption)
      try {
        return {
          placeholderColor: getComputedStyle(input, '::placeholder').color,
          captionColor: getComputedStyle(caption).color,
          iconCount: wrapper.querySelectorAll('svg').length,
          background: getComputedStyle(wrapper).backgroundColor,
          radius: getComputedStyle(wrapper).borderRadius,
          padding: getComputedStyle(wrapper).padding,
          fontSize: getComputedStyle(input).fontSize,
        }
      } finally {
        caption.remove()
      }
    })
    expect(searchStyle.placeholderColor).toBe(searchStyle.captionColor)
    expect(searchStyle.iconCount).toBe(0)
    expect(searchStyle.background).toBe('rgba(0, 0, 0, 0)')
    expect(searchStyle.radius).toBe('8px')
    expect(searchStyle.padding).toBe('5px 7px')
    expect(searchStyle.fontSize).toBe('12px')
    const modelWeights = await page.getByRole('menuitemradio').evaluateAll(rows => rows.map(row =>
      getComputedStyle(row.querySelector('span span')!).fontWeight,
    ))
    expect(new Set(modelWeights)).toEqual(new Set(['500']))
    const headingPalettes = await page.getByRole('group', { name: '模型与推理等级', exact: true }).evaluate((menu) => {
      const html = menu.ownerDocument.documentElement
      const body = menu.ownerDocument.body
      const previousPlatform = html.getAttribute('data-platform')
      const previousTheme = body.getAttribute('data-ds-dark-theme')
      try {
        return ['web', 'win32', 'darwin'].flatMap(platform => [false, true].map((dark) => {
          if (platform === 'web') html.removeAttribute('data-platform')
          else html.setAttribute('data-platform', platform)
          body.toggleAttribute('data-ds-dark-theme', dark)
          const headings = [...menu.querySelectorAll('section[role="group"] > div')]
          return {
            platform, dark,
            headingFills: [...new Set(headings.map(heading => getComputedStyle(heading).backgroundColor))],
            positions: [...new Set(headings.map(heading => getComputedStyle(heading).position))],
            headingRadii: [...new Set(headings.map(heading => getComputedStyle(heading).borderRadius))],
            optionRadius: getComputedStyle(menu.querySelector('[role="menuitemradio"]')!).borderRadius,
            searchBorder: getComputedStyle(menu.querySelector('input')!.parentElement!).borderColor,
          }
        }))
      } finally {
        if (previousPlatform === null) html.removeAttribute('data-platform')
        else html.setAttribute('data-platform', previousPlatform)
        if (previousTheme === null) body.removeAttribute('data-ds-dark-theme')
        else body.setAttribute('data-ds-dark-theme', previousTheme)
      }
    })
    for (const palette of headingPalettes) {
      expect(palette.headingFills, `${palette.platform}, dark=${String(palette.dark)}`)
        .toEqual(['rgba(0, 0, 0, 0)'])
      expect(palette.searchBorder).toBe('rgba(0, 0, 0, 0)')
      expect(palette.positions).toEqual(['sticky'])
      expect(palette.headingRadii).toEqual([palette.platform === 'darwin' ? '0px' : '8px'])
    }
    await search.fill('zzzz')
    await page.getByText('没有匹配的模型。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    expect(await search.inputValue()).toBe('')
    expect(await search.evaluate(input => input === input.ownerDocument.activeElement)).toBe(true)
    expect(await page.getByRole('menuitemradio').count()).toBe(modelWeights.length)
    expect(await page.getByRole('button', { name: '清除搜索', exact: true }).count()).toBe(0)
    await search.fill('  ACMLG  ')
    expect(await page.getByRole('menuitemradio').allTextContents()).toEqual(['Acme Large仅文本'])
    expect(await page.getByRole('group', { name: 'Origin Gateway', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./snapshots/default-model/search.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="group"][aria-label="模型与推理等级"]', scaffold.workspaceCwd),
      webSnapshotMode(),
    )
    await search.press('ArrowDown')
    await expect.poll(() => search.evaluate(input => input === input.ownerDocument.activeElement)).toBe(true)
    expect(await search.getAttribute('aria-activedescendant'))
      .toBe(await page.getByRole('menuitemradio', { name: /^Acme Large/ }).getAttribute('id'))
    await page.keyboard.press('Enter')
    await expect.poll(() => trigger.getAttribute('aria-busy')).toBe('false')
    await expect.poll(() => trigger.textContent()).toContain('Acme Large')
    await expect.poll(() => trigger.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    // Focused trigger carries the design's focus ring, not an open-menu glow.
    expect(await trigger.evaluate(element => getComputedStyle(element).boxShadow)).toBe('rgba(0, 0, 0, 0.12) 0px 0px 0px 2px')
    const aria = await captureStableAria(page, '[data-composer-card]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(fileURLToPath(new URL('./snapshots/default-model/background-save.expected.md', import.meta.url)), aria, webSnapshotMode())

    // The switch is what sets the default: the shared Agent-route settings section
    // now names it, beside the provider profiles the Models page writes.
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('agent-default-model:')
    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain(`provider: ${ROUTE}`)
    expect(document).toContain(`model: ${MODEL}`)

    // A session created after the switch starts from it...
    expect(await currentOf(await createSession('default-model-after')))
      .toEqual({ provider: ROUTE, model: MODEL })
    // ...while the one holding a logged route keeps deriving from its log.
    expect(await currentOf(loggedId)).toEqual({ provider: START_ROUTE, model: START_MODEL })
    await trigger.press('Tab')
    await trigger.focus()
    expect(await trigger.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    expect(await trigger.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('goes inert when the route the default names stops being served', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-default-model-blocked'))
    const box = composerInput(page)
    await expect.poll(async () => box.isEnabled(), { timeout: 10_000 }).toBe(true)

    // What removing the provider on the Models page leaves behind: the saved
    // default still names the route, and nothing serves it any more.
    // `replace`, not `update`: a merge patch of `{providers: {}}` leaves every
    // stored profile in place.
    await scaffold.ctx.settings.replace(settingsNamespace('llm-pi-ai'), { providers: {} })

    await expect.poll(async () => box.isEnabled(), { timeout: 15_000 }).toBe(false)
    expect(await box.getAttribute('placeholder')).toBe('当前模型不可用，请先选择模型')

    // The block is an affordance; the refusal is the Host's. A client that
    // never disabled anything still cannot start a turn on a dead route.
    const refused = await scaffold.ctx.apiProxy.sessions.prompt({
      rpcId: 'default-model-refused' as never,
      payload: {
        sessionId: SessionId(await createSession('default-model-refusal')),
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'hi' }],
      },
    })
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'model-unavailable' } })

    // The way out stays open. Locking the model seat with everything else
    // would leave the composer asking for the one thing it prevents.
    const seat = page.getByRole('button', { name: /^选择模型/ })
    expect(await seat.isEnabled()).toBe(true)
    if (await seat.getAttribute('aria-expanded') === 'true') {
      await seat.click()
      await expect.poll(() => seat.getAttribute('aria-expanded')).toBe('false')
    }
    await seat.click()
    await expect.poll(() => seat.getAttribute('aria-expanded')).toBe('true')
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio').first().click()
    await expect.poll(async () => box.isEnabled(), { timeout: 15_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
