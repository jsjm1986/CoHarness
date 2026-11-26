/** Every published documentation route is rendered at every supported layout boundary. */
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page, Route } from 'playwright'
import { preview, type PreviewServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docsPages, routeLink, type DocsPage } from '../../../website/docs.ts'
import { auditResponsiveControl, auditResponsiveControls, responsiveControlAudit } from '../tests/responsive-controls.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation } from '../tests/responsive-browser.ts'

const root = fileURLToPath(new URL('../../../website', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const engine = responsiveBrowserName
const allViewports = [
  [320, 568], [344, 882], [360, 640], [375, 667], [390, 844], [412, 915], [430, 932], [540, 720],
  [767, 800], [768, 800], [769, 800], [959, 800], [960, 800], [961, 800], [1024, 768],
  [568, 320], [844, 390], [932, 430],
] as const
const requestedWidths = process.env.DSH_DOCS_VIEWPORTS?.split(',').map(Number)
if (requestedWidths?.some(width => !allViewports.some(([candidate]) => candidate === width))) {
  throw new Error('DSH_DOCS_VIEWPORTS must name declared documentation widths')
}
const viewports = allViewports.filter(([width]) => requestedWidths === undefined || requestedWidths.includes(width))
const requestedRoutes = process.env.DSH_DOCS_ROUTES?.split(',')
if (requestedRoutes?.some(route => !docsPages.some(doc => doc.route === route))) {
  throw new Error('DSH_DOCS_ROUTES must name published manifest routes, including .md')
}
const routes = docsPages.filter(doc => requestedRoutes === undefined || requestedRoutes.includes(doc.route))
const notFoundRoutes = [
  { route: 'qa-unpublished-responsive-acceptance.md', locale: 'root', home: '/', lang: 'zh-CN' },
  { route: 'en/qa-unpublished-responsive-acceptance.md', locale: 'en', home: '/en/', lang: 'en-US' },
] as const
const diagramCounts = new Map(docsPages.map(doc => [doc.route,
  [...readFileSync(join(repository, doc.source), 'utf8').matchAll(/^\s*```(?:mermaid|mmd)\s*$/gm)].length]))
const artifacts = process.env.DSH_DOCS_RESPONSIVE_ARTIFACTS
const screenshotWidths = process.env.DSH_DOCS_SCREENSHOT_WIDTHS?.split(',').map(Number) ?? [320, 390, 844, 1024]
if (screenshotWidths.some(width => !allViewports.some(([candidate]) => candidate === width))) {
  throw new Error('DSH_DOCS_SCREENSHOT_WIDTHS must name declared documentation widths')
}
interface Receipt {
  scope: 'route' | 'shared-component' | 'not-found-route'
  route: string
  actualRoute: string
  state: string
  viewport: { width: number; height: number }
  pointer: { coarse: boolean; hover: boolean; touchPoints: number }
  checker: typeof responsiveControlAudit
  checks: string[]
  status: 'passed' | 'failed'
  error?: string
  screenshots: string[]
}
const receipts: Receipt[] = []
const cases: Array<{ route: string; scenario: string; viewport?: { width: number; height: number }; status: 'passed' | 'failed'; error?: string }> = []

async function checkFlow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const content = '.vp-doc :is(h1, h2, h3, p, ul, ol, table, pre, .mermaid, .documentation-table-scroll)'
    const outside = [...document.querySelectorAll<HTMLElement>(content)]
      .filter((element) => {
        if (element.parentElement?.closest('.documentation-table-scroll')) return false
        const box = element.getBoundingClientRect()
        return element.closest('[inert]') === null && box.width > 0 && getComputedStyle(element).display !== 'none'
          && (box.left < -1 || box.right > innerWidth + 1)
      }).map(element => `${element.tagName} ${element.textContent?.slice(0, 80)}`)
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, outside }
  })
  expect(geometry.width).toBe(page.viewportSize()!.width)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
  expect(geometry.outside).toEqual([])
}

async function inspect(page: Page, doc: Pick<DocsPage, 'route'>, state: string, scope: Receipt['scope'],
  surface = page.locator('body'), additionalChecks: string[] = []): Promise<void> {
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('Documentation acceptance requires an explicit viewport')
  let failure: string | undefined
  const screenshots: string[] = []
  const capture = async (phase: string): Promise<void> => {
    if (artifacts === undefined) return
    const path = join(artifacts, `${doc.route.replaceAll('/', '_').replace('.md', '')}-${engine}-${viewport.width}-${scope}-${state}-${phase}.png`)
    await page.screenshot({ path })
    screenshots.push(path)
  }
  try {
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    if (screenshotWidths.includes(viewport.width)) await capture('start')
    await checkFlow(page)
    await auditResponsiveControls(page, surface, `Documentation ${doc.route} ${state}`)
    if (screenshotWidths.includes(viewport.width)) await capture('inspected')
  } catch (error) { failure = String(error); await capture('failed'); throw error }
  finally {
    const receipt: Receipt = { scope, route: routeLink(doc.route), actualRoute: new URL(page.url()).pathname, state, viewport,
      pointer: await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches,
        hover: matchMedia('(hover: hover)').matches, touchPoints: navigator.maxTouchPoints })),
      checker: responsiveControlAudit, checks: [...responsiveControlAudit.checks, 'document-horizontal-flow', ...additionalChecks],
      status: failure === undefined ? 'passed' : 'failed', screenshots,
      ...(failure === undefined ? {} : { error: failure }) }
    receipts.push(receipt)
    if (artifacts !== undefined) await appendFile(join(artifacts, `states-${engine}.jsonl`), JSON.stringify(receipt) + '\n')
  }
}

async function tap(page: Page, control: Locator, label: string): Promise<void> {
  await auditResponsiveControl(page, control, label)
  await control.tap()
}

async function waitForDiagrams(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.vp-doc .mermaid').evaluateAll(containers => containers.every((container) => {
    const svg = container.querySelector<SVGSVGElement>('svg:not(.dsh-diagram-icon)')
    return svg !== null && svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0
      && container.querySelector('.dsh-diagram-open') !== null
  }))).toBe(true)
}

async function diagramState(page: Page, doc: DocsPage, index: number, full: boolean): Promise<void> {
  const container = page.locator('.vp-doc .mermaid').nth(index)
  const trigger = container.locator('.dsh-diagram-open')
  const source = container.locator('svg:not(.dsh-diagram-icon)').first()
  const original = await source.evaluate(element => element.outerHTML)
  const overflow = await page.evaluate(() => document.body.style.overflow)
  const chinese = doc.locale === 'root'
  await tap(page, trigger, 'Open diagram')
  const dialog = page.locator('dialog.dsh-diagram-viewer')
  await dialog.waitFor()
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true)
  const close = dialog.getByRole('button', { name: chinese ? '关闭' : 'Close', exact: true })
  await expect.poll(() => close.evaluate(element => element === document.activeElement)).toBe(true)
  const paper = dialog.locator('.dsh-diagram-paper')
  expect(await paper.evaluate(element => element.shadowRoot?.querySelector('svg')?.getAttribute('viewBox')))
    .toBe(await source.getAttribute('viewBox'))
  await inspect(page, doc, full ? 'diagram-open' : `diagram-${index}-open`, full ? 'shared-component' : 'route', dialog,
    ['native-modal', 'isolated-svg-copy'])
  if (full) {
    const transform = () => paper.evaluate((element) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
      return { scale: matrix.a, x: matrix.e, y: matrix.f }
    })
    const fitted = await transform()
    await tap(page, dialog.getByRole('button', { name: chinese ? '放大' : 'Zoom in', exact: true }), 'Zoom diagram')
    await expect.poll(async () => (await transform()).scale).toBeGreaterThan(fitted.scale)
    await inspect(page, doc, 'diagram-zoomed-in', 'shared-component', dialog)
    await tap(page, dialog.getByRole('button', { name: chinese ? '缩小' : 'Zoom out', exact: true }), 'Zoom diagram out')
    await expect.poll(async () => (await transform()).scale).toBeCloseTo(fitted.scale, 3)
    await inspect(page, doc, 'diagram-zoomed-out', 'shared-component', dialog)
    await close.focus()
    const beforeKey = await transform()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await transform()).x).not.toBe(beforeKey.x)
    await inspect(page, doc, 'diagram-keyboard-panned', 'shared-component', dialog, ['keyboard-pan'])
    const viewport = await dialog.locator('.dsh-diagram-viewport').boundingBox()
    if (viewport === null) throw new Error('Diagram viewport disappeared')
    const beforeDrag = await transform()
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
    await page.mouse.down()
    try { await page.mouse.move(viewport.x + viewport.width / 2 + 24, viewport.y + viewport.height / 2 + 16, { steps: 4 }) }
    finally { await page.mouse.up() }
    await expect.poll(async () => (await transform()).x).not.toBe(beforeDrag.x)
    await inspect(page, doc, 'diagram-pointer-panned', 'shared-component', dialog, ['mouse-pan'])
    await tap(page, dialog.getByRole('button', { name: chinese ? '适应窗口' : 'Fit view', exact: true }), 'Fit diagram')
    await expect.poll(async () => (await transform()).scale).toBeCloseTo(fitted.scale, 3)
    await expect.poll(async () => (await transform()).x).toBeCloseTo(0, 3)
    await expect.poll(async () => (await transform()).y).toBeCloseTo(0, 3)
    await inspect(page, doc, 'diagram-refitted', 'shared-component', dialog)
    const help = dialog.getByRole('button', { name: chinese ? '查看器帮助' : 'Viewer help', exact: true })
    await tap(page, help, 'Diagram help')
    expect(await help.getAttribute('aria-expanded')).toBe('true')
    await dialog.locator('.dsh-diagram-help').waitFor()
    await inspect(page, doc, 'diagram-help-open', 'shared-component', dialog)
    await tap(page, help, 'Close diagram help')
  }
  await tap(page, close, 'Close diagram')
  await dialog.waitFor({ state: 'hidden' })
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(overflow)
  expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
  expect(await source.evaluate(element => element.outerHTML)).toBe(original)
  await inspect(page, doc, full ? 'diagram-button-closed' : `diagram-${index}-closed`, full ? 'shared-component' : 'route', container,
    ['close-button', 'focus-return', 'source-svg-unchanged'])
  if (full) {
    await tap(page, trigger, 'Reopen diagram')
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(overflow)
    await inspect(page, doc, 'diagram-escape-closed', 'shared-component', container, ['escape-dismissal', 'focus-return'])
  }
}

async function markdownLink(page: Page, doc: DocsPage, scope: Receipt['scope'] = 'route'): Promise<void> {
  const toggle = page.locator('.page-markdown-toggle')
  await tap(page, toggle, 'Page Markdown menu')
  const menu = page.locator('.page-markdown-menu')
  await menu.waitFor()
  await inspect(page, doc, 'markdown-menu', scope, menu)
  const view = menu.locator('a[role="menuitem"]')
  const raw = new URL((await view.getAttribute('href'))!, page.url())
  expect(raw.pathname).toBe('/' + doc.route)
  await auditResponsiveControl(page, view, 'View current page Markdown')
  const [popup] = await Promise.all([page.waitForEvent('popup'), view.tap()])
  try {
    await popup.waitForURL(raw.href)
    const response = await popup.request.get(raw.href)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/^text\/(?:markdown|plain)(?:;|$)/)
    expect((await response.text()).trim().length).toBeGreaterThan(0)
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
  } finally { await popup.close() }
  await menu.waitFor({ state: 'hidden' })
  await inspect(page, doc, 'markdown-link-opened', scope, page.locator('.page-markdown-actions'), ['raw-markdown-http', 'new-tab-no-opener'])
}

async function openAppearance(page: Page): Promise<Locator> {
  const hamburger = page.locator('.VPNavBarHamburger')
  if (await hamburger.isVisible()) {
    await tap(page, hamburger, 'Open site navigation')
    await expect.poll(() => hamburger.getAttribute('aria-expanded')).toBe('true')
    return page.locator('.VPNavScreen')
  }
  const extra = page.locator('.VPNavBarExtra > button')
  const flyout = page.locator('.VPNavBarExtra')
  await tap(page, extra, 'Open extra navigation')
  // VPFlyout opens on hover and toggles `open` on click, so a tap's synthesized
  // mouseenter precedes the click and leaves `open` false while `.menu` stays
  // open under `:hover`. WebKit does not hold that synthesized hover, so the
  // menu closes before later taps land and they fall through to page content.
  // With the pointer already on the trigger, a second tap produces no fresh
  // mouseenter — only the click toggling `open` true, the functional state.
  if (!(await flyout.evaluate(element => element.classList.contains('open')))) await extra.tap()
  const menu = page.locator('.VPNavBarExtra .menu')
  await menu.waitFor({ state: 'visible' })
  return menu
}

async function closeAppearance(page: Page): Promise<void> {
  const hamburger = page.locator('.VPNavBarHamburger')
  if (await hamburger.isVisible()) {
    // Idempotent: an SPA navigation can already have collapsed the screen nav.
    if ((await hamburger.getAttribute('aria-expanded')) === 'true') {
      await tap(page, hamburger, 'Close navigation options')
      await expect.poll(() => hamburger.getAttribute('aria-expanded')).toBe('false')
    }
    return
  }
  // Outside touch closes the expanded menu. Pointer departure clears its hover state.
  await page.locator('.VPContent h1').first().tap()
  await page.mouse.move(0, 0)
  await page.locator('.VPNavBarExtra .menu').waitFor({ state: 'hidden' })
}

async function searchStates(page: Page, doc: DocsPage): Promise<void> {
  await tap(page, page.locator('.VPNavBarSearch button').first(), 'Open documentation search')
  const search = page.locator('.VPLocalSearchBox')
  const input = search.locator('input[type="search"]')
  await input.waitFor()
  await expect.poll(() => input.evaluate(element => element === document.activeElement)).toBe(true)
  await input.fill('')
  await inspect(page, doc, 'search-empty', 'shared-component', search)
  await input.fill('zzzzqaunmatchedlongdocumentationquery01234567890123456789')
  await search.locator('.no-results').waitFor()
  await inspect(page, doc, 'search-long-no-results', 'shared-component', search)
  await tap(page, search.locator('.clear-button'), 'Clear search')
  expect(await input.inputValue()).toBe('')
  await inspect(page, doc, 'search-reset', 'shared-component', search)
  await input.fill('Harness')
  await search.locator('a.result').first().waitFor()
  await inspect(page, doc, 'search-results', 'shared-component', search)
  const detailed = search.locator('.toggle-layout-button')
  if (!(await detailed.getAttribute('class'))?.includes('detailed-list')) await tap(page, detailed, 'Expand search excerpts')
  await search.locator('.result .excerpt').first().waitFor()
  await inspect(page, doc, 'search-detailed-results', 'shared-component', search)
  await page.keyboard.press('Escape')
  await search.waitFor({ state: 'hidden' })
  await inspect(page, doc, 'search-escape-closed', 'shared-component', page.locator('.VPNavBarSearch'))
  await tap(page, page.locator('.VPNavBarSearch button').first(), 'Reopen documentation search')
  const result = search.locator('a.result').first()
  await result.waitFor()
  const target = new URL((await result.getAttribute('href'))!, page.url())
  await tap(page, result, 'Open search result')
  await search.waitFor({ state: 'hidden' })
  await page.waitForURL(target.href)
  await page.locator('.VPContent').waitFor()
  await inspect(page, doc, 'search-result-opened', 'shared-component', page.locator('.VPContent'), ['search-result-navigation'])
}

async function markdownCopyStates(page: Page, doc: DocsPage, copied: Array<{ text: string; active: boolean }>): Promise<void> {
  const button = page.locator('.page-markdown-copy')
  const status = page.locator('.page-markdown-actions-status')
  const raw = new URL('/' + doc.route, page.url()).href
  const response = await page.request.get(raw)
  expect(response.ok()).toBe(true)
  // The emitted .md carries a UTF-8 BOM for charset-less hosting; `Blob.text()`
  // strips it during decoding, so the clipboard-visible text drops the mark.
  const expected = (await response.text()).replace(/^﻿/, '')
  const matches = (url: URL): boolean => url.href === raw + '?dsh-raw=1'
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let arrived = false
  let pending: Promise<void> | undefined
  const hold = (route: Route): Promise<void> => { arrived = true; pending = released.then(() => route.continue()); return pending }
  await page.route(matches, hold)
  try {
    await tap(page, button, 'Copy page Markdown')
    await expect.poll(() => arrived).toBe(true)
    expect(await button.getAttribute('aria-busy')).toBe('true')
    await inspect(page, doc, 'markdown-copy-pending', 'shared-component', page.locator('.page-markdown-actions'))
  } finally { release(); await pending; await page.unroute(matches, hold) }
  await expect.poll(() => copied.length).toBe(1)
  expect(copied[0]).toEqual({ text: expected, active: true })
  await expect.poll(() => status.innerText()).toBe(doc.locale === 'root' ? '已复制 Markdown。' : 'Markdown copied.')
  await auditResponsiveControl(page, status, 'Markdown copy success feedback')
  await inspect(page, doc, 'markdown-copy-succeeded', 'shared-component', page.locator('.page-markdown-actions'), ['raw-markdown-bytes', 'clipboard-adapter', 'trusted-user-activation'])
  const toggle = page.locator('.page-markdown-toggle')
  await toggle.focus()
  await page.keyboard.press('ArrowUp')
  const menu = page.locator('.page-markdown-menu')
  const copyItem = menu.locator('button[role="menuitem"]')
  const viewItem = menu.locator('a[role="menuitem"]')
  await expect.poll(() => viewItem.evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.press('Home')
  await expect.poll(() => copyItem.evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.press('End')
  await expect.poll(() => viewItem.evaluate(element => element === document.activeElement)).toBe(true)
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => copyItem.evaluate(element => element === document.activeElement)).toBe(true)
  await inspect(page, doc, 'markdown-keyboard-menu', 'shared-component', menu, ['arrow-home-end-navigation'])
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  expect(await toggle.evaluate(element => element === document.activeElement)).toBe(true)
  await inspect(page, doc, 'markdown-keyboard-closed', 'shared-component', page.locator('.page-markdown-actions'), ['escape-dismissal', 'focus-return'])
  await tap(page, toggle, 'Open menu copy action')
  await tap(page, copyItem, 'Copy Markdown from menu')
  await menu.waitFor({ state: 'hidden' })
  await expect.poll(() => copied.length).toBe(2)
  expect(copied[1]).toEqual({ text: expected, active: true })
  await expect.poll(() => status.innerText()).toBe(doc.locale === 'root' ? '已复制 Markdown。' : 'Markdown copied.')
  await auditResponsiveControl(page, status, 'Menu Markdown copy success feedback')
  await inspect(page, doc, 'markdown-menu-copy-succeeded', 'shared-component', page.locator('.page-markdown-actions'), ['clipboard-adapter', 'menu-copy-action'])
  const refuse = async (route: Route): Promise<void> => { await route.fulfill({ status: 503, contentType: 'text/plain', body: 'QA unavailable' }) }
  await page.route(matches, refuse)
  try {
    await tap(page, button, 'Retry unavailable Markdown')
    await expect.poll(() => status.innerText()).toMatch(doc.locale === 'root' ? /^无法加载 Markdown/ : /^Could not load Markdown/)
    await auditResponsiveControl(page, status, 'Markdown request failure feedback')
    await inspect(page, doc, 'markdown-fetch-refused', 'shared-component', page.locator('.page-markdown-actions'), ['http-refusal-feedback'])
  } finally { await page.unroute(matches, refuse) }
  await page.evaluate(() => { Reflect.set(window, '__docsClipboardDenied', true) })
  await tap(page, button, 'Copy with denied clipboard')
  await expect.poll(() => status.innerText()).toMatch(doc.locale === 'root' ? /^复制失败/ : /^Could not copy/)
  await auditResponsiveControl(page, status, 'Markdown clipboard failure feedback')
  await inspect(page, doc, 'markdown-clipboard-refused', 'shared-component', page.locator('.page-markdown-actions'), ['clipboard-adapter-refusal'])
  await page.evaluate(() => { Reflect.set(window, '__docsClipboardDenied', false) })
}

describe('documentation route responsive acceptance', () => {
  let server: PreviewServer
  let browser: Browser
  let origin: string
  beforeAll(async () => {
    expect(docsPages.length).toBeGreaterThan(0)
    expect(new Set(docsPages.map(page => page.route)).size).toBe(docsPages.length)
    if (artifacts !== undefined) {
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(artifacts, `states-${engine}.jsonl`), '')
      await writeFile(join(artifacts, `plan-${engine}.json`), JSON.stringify({ checker: responsiveControlAudit,
        manifestRoutes: docsPages.length, scheduledRoutes: routes.map(doc => routeLink(doc.route)), viewports,
        notFoundRoutes: notFoundRoutes.map(doc => ({ route: routeLink(doc.route), home: doc.home, locale: doc.locale })),
        notFoundHttpMeaning: 'Records the local preview response status. Rendered unknown-route behavior does not establish production HTTP status configuration.',
        diagramCounts: Object.fromEntries(diagramCounts),
        screenshotWidths,
        sharedComponentHosts: ['guide/quickstart.md', 'en/guide/quickstart.md', 'guide/providers.md', 'en/guide/providers.md',
          ...(['root', 'en'] as const).map(locale => docsPages.find(doc => doc.locale === locale && (diagramCounts.get(doc.route) ?? 0) > 0)?.route)],
        hasTouch: true, mobileEmulation: responsiveMobileEmulation,
        routeCoverage: 'Every selected route and diagram at every selected size. Shared-component results never substitute for route results.',
        resultMeaning: 'State receipts cover only completed checks; overall acceptance also requires the corresponding case and Vitest result. Absent cells remain unexecuted.',
        nativeClipboard: false, nativeTouchPinch: false }, null, 2) + '\n')
    }
    // `vitepress serve` semantics: the built site is an MPA, and an unmatched
    // non-asset GET answers with 404.html and a 404 status, never with the
    // index redirect stub. A bare `vite preview` defaults to `spa`, whose
    // index.html fallback loops the stub's relative refresh forever.
    const notFoundPage = readFileSync(join(root, '.dist', '404.html'), 'utf8')
    server = await preview({ root, configFile: false, appType: 'mpa', build: { outDir: '.dist' }, preview: { host: '127.0.0.1', port: 0 },
      plugins: [{
        name: 'dsh-docs-preview-not-found',
        configurePreviewServer(previewServer) {
          return () => {
            previewServer.middlewares.use((req, res, next) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') return next()
              // Reachable only after htmlFallback rewrote matching URLs; a
              // resolvable candidate here still belongs to indexHtmlMiddleware.
              const pathname = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
              const candidate = pathname.endsWith('.html') ? pathname
                : pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}.html`
              if (existsSync(join(root, '.dist', candidate))) return next()
              res.statusCode = 404
              if (!pathname.includes('/assets/')) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8')
                res.write(notFoundPage)
              }
              res.end()
            })
          }
        },
      }] })
    const address = server.httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('Documentation preview did not bind TCP')
    origin = `http://127.0.0.1:${address.port}`
    browser = await responsiveBrowser.launch()
  })
  afterAll(async () => {
    try {
      const output = process.env.DSH_DOCS_RESPONSIVE_ARTIFACTS
      if (output) {
        await mkdir(output, { recursive: true })
        await writeFile(join(output, `receipts-${engine}.json`), JSON.stringify(receipts, null, 2) + '\n')
        await writeFile(join(output, `cases-${engine}.json`), JSON.stringify(cases, null, 2) + '\n')
      }
    } finally {
      try { await browser?.close() } finally {
        if (server) await new Promise<void>((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
      }
    }
  })

  async function open(doc: DocsPage, width: number, height: number, clipboard = false): Promise<{
    page: Page
    errors: string[]
    copied: Array<{ text: string; active: boolean }>
  }> {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true,
      isMobile: responsiveMobileEmulation, reducedMotion: 'reduce', colorScheme: 'light' })
    const errors: string[] = []
    const copied: Array<{ text: string; active: boolean }> = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      if (clipboard) {
        await page.exposeFunction('__docsRecordClipboard', (text: string, active: boolean) => { copied.push({ text, active }) })
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            write: async (items: ClipboardItem[]): Promise<void> => {
              const active = navigator.userActivation.isActive
              if (Reflect.get(window, '__docsClipboardDenied') === true) throw new DOMException('QA permission denied', 'NotAllowedError')
              const blob = await items[0]!.getType('text/plain')
              const record = Reflect.get(window, '__docsRecordClipboard') as (text: string, active: boolean) => Promise<void>
              await record(await blob.text(), active)
            },
            writeText: async (text: string): Promise<void> => {
              const record = Reflect.get(window, '__docsRecordClipboard') as (text: string, active: boolean) => Promise<void>
              await record(text, navigator.userActivation.isActive)
            },
          } })
        })
      }
      const response = await page.goto(origin + routeLink(doc.route), { waitUntil: 'networkidle' })
      expect(response?.status()).toBe(200)
      await page.locator('.VPContent').waitFor()
      await expect.poll(() => page.locator('.vp-doc .mermaid').count()).toBe(diagramCounts.get(doc.route))
      await waitForDiagrams(page)
      return { page, errors, copied }
    } catch (error) {
      cases.push({ route: doc.route, scenario: 'page-bootstrap', viewport: { width, height }, status: 'failed', error: String(error) })
      try {
        if (artifacts !== undefined) {
          await page.screenshot({ path: join(artifacts, `${doc.route.replaceAll('/', '_')}-${engine}-${width}-bootstrap-failed.png`) })
        }
      } finally { await page.close() }
      throw error
    }
  }

  for (const missing of notFoundRoutes) {
    it.each(viewports)(`${missing.locale} unknown route preserves navigation and returns home at %i×%i`, async (width, height) => {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true,
        isMobile: responsiveMobileEmulation, reducedMotion: 'reduce', colorScheme: 'light' })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      try {
        const response = await page.goto(origin + routeLink(missing.route), { waitUntil: 'networkidle' })
        expect(response).not.toBeNull()
        const notFound = page.locator('.NotFound')
        await notFound.waitFor()
        expect(await notFound.locator('.code').innerText()).toBe('404')
        expect((await notFound.getByRole('heading', { level: 1 }).innerText()).trim().length).toBeGreaterThan(0)
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(missing.lang)
        expect(await page.locator('.page-markdown-actions').count()).toBe(0)
        for (const selector of ['.code', 'h1', '.quote']) {
          await auditResponsiveControl(page, notFound.locator(selector), `Unknown route readable ${selector}`)
        }
        await inspect(page, missing, 'not-found-light', 'not-found-route', page.locator('body'),
          ['rendered-404', 'no-page-markdown-actions', `preview-http-${response!.status()}`])
        await tap(page, page.locator('.VPNavBarSearch button').first(), 'Open search from unknown route')
        const search = page.locator('.VPLocalSearchBox')
        const input = search.locator('input[type="search"]')
        await input.waitFor()
        await input.fill('')
        await inspect(page, missing, 'not-found-search-empty', 'not-found-route', search)
        await input.fill('zzzzqaunpublishedpage01234567890123456789')
        await search.locator('.no-results').waitFor()
        await inspect(page, missing, 'not-found-search-unmatched', 'not-found-route', search)
        await page.keyboard.press('Escape')
        await search.waitFor({ state: 'hidden' })
        await notFound.waitFor()
        expect(new URL(page.url()).pathname).toBe(routeLink(missing.route))
        await inspect(page, missing, 'not-found-search-closed', 'not-found-route', notFound)
        const options = await openAppearance(page)
        await inspect(page, missing, 'not-found-navigation-open', 'not-found-route', options)
        await tap(page, options.locator('.VPSwitchAppearance'), 'Change unknown-route theme')
        await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
        await closeAppearance(page)
        await inspect(page, missing, 'not-found-dark', 'not-found-route', page.locator('body'))
        const home = notFound.locator('.action a')
        expect(await home.getAttribute('href')).toBe(missing.home)
        await tap(page, home, 'Return from unknown route to its language home')
        await page.waitForURL(origin + missing.home)
        await notFound.waitFor({ state: 'hidden' })
        // Each locale home is a redirect stub onto its first guide page, so the
        // landed document surface is `.VPContent`, not a `layout: home` `.VPHome`.
        await page.locator('.VPContent').waitFor()
        expect(await page.locator('html').getAttribute('lang')).toBe(missing.lang)
        await inspect(page, missing, 'not-found-returned-home', 'not-found-route', page.locator('.VPContent'), ['actual-home-navigation'])
        expect(errors).toEqual([])
        cases.push({ route: missing.route, scenario: 'not-found-navigation', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: missing.route, scenario: 'not-found-navigation', viewport: { width, height }, status: 'failed', error: String(error) })
        if (artifacts !== undefined) await page.screenshot({
          path: join(artifacts, `${missing.route.replaceAll('/', '_')}-${engine}-${width}-not-found-case-failed.png`),
        })
        throw error
      } finally { await page.close() }
    })
  }

  it.each(routes)('$route has readable content and reachable controls at every size', async (doc) => {
    const { page, errors } = await open(doc, viewports[0]![0], viewports[0]![1])
    try {
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height })
        // Taps from a previous viewport leave the real mouse on that spot; the
        // resize re-evaluates :hover under it and hover-opened chrome like the
        // translations flyout would block the page's own controls. Park the
        // pointer at a neutral corner before the audit.
        await page.mouse.move(0, 0)
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }))
        await inspect(page, doc, 'page-controls', 'route')
        const diagrams = await page.locator('.vp-doc .mermaid').count()
        for (let index = 0; index < diagrams; index++) await diagramState(page, doc, index, false)
      }
      await page.setViewportSize({ width: 320, height: 568 })
      // Redirect stubs land on their target and show that page's chrome; the
      // actions-row count is only owned by a page still serving its own route.
      const landed = new URL(page.url()).pathname === routeLink(doc.route)
      expect(await page.locator('.page-markdown-toggle').count())
        .toBe(landed && doc.sidebar === null ? 0 : 1)
      if (doc.sidebar !== null && landed) await markdownLink(page, doc)
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark')
        await waitForDiagrams(page)
        await page.mouse.move(0, 0)
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }))
        await inspect(page, doc, `preferred-${theme}`, 'route')
      }
      const text = page.locator('.vp-doc p').first()
      if (await text.count() > 0) {
        const before = await text.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
        await page.locator('.vp-doc').evaluate((element) => {
          const nodes = [element, ...element.querySelectorAll('*')].filter((node): node is HTMLElement => node instanceof HTMLElement)
          const sizes = nodes.map(node => ({ node, size: Number.parseFloat(getComputedStyle(node).fontSize) }))
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`
        })
        // WCAG 1.4.12 spacing applies to every block of text, table cells included.
        await page.addStyleTag({ content: '.vp-doc :is(p,li,td,th) { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } .vp-doc p { margin-block-end: 2em !important; }' })
        expect(await text.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(before * 2, 2)
        await page.mouse.move(0, 0)
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: 'instant' }))
        await inspect(page, doc, 'content-text-200-spacing', 'route', page.locator('.VPContent'), ['computed-text-doubling'])
      }
      expect(errors).toEqual([])
      cases.push({ route: doc.route, scenario: 'route', status: 'passed' })
    } catch (error) {
      cases.push({ route: doc.route, scenario: 'route', status: 'failed', error: String(error) })
      throw error
    } finally { await page.close() }
    // Catalog pages carry hundreds of audited controls; one full route pass
    // runs every viewport, both themes, and the spacing scenario against them.
    // WebKit measures a catalog route at ~14 minutes under serial workers.
  }, 1_200_000)

  for (const locale of ['root', 'en'] as const) {
    const doc = docsPages.find(candidate => candidate.locale === locale && candidate.route.endsWith('guide/quickstart.md'))!
    it.each(viewports)(`${locale} shared navigation/theme/language at %i×%i`, async (width, height) => {
      const { page, errors } = await open(doc, width, height)
      try {
        let options = await openAppearance(page)
        await inspect(page, doc, 'site-navigation-open', 'shared-component', options)
        const appearance = options.locator('.VPSwitchAppearance')
        expect(await appearance.getAttribute('aria-checked')).toBe('false')
        await tap(page, appearance, 'Switch to dark theme')
        await expect.poll(() => appearance.getAttribute('aria-checked')).toBe('true')
        await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
        await inspect(page, doc, 'appearance-dark', 'shared-component', options, ['appearance-switch'])
        await closeAppearance(page)
        await page.reload({ waitUntil: 'networkidle' })
        await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(true)
        await inspect(page, doc, 'appearance-dark-reloaded', 'shared-component', page.locator('.VPContent'), ['appearance-persistence'])
        options = await openAppearance(page)
        await tap(page, options.locator('.VPSwitchAppearance'), 'Switch to light theme')
        await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(false)
        await inspect(page, doc, 'appearance-light', 'shared-component', options)
        const languages = options.locator('.VPNavScreenTranslations')
        if (await languages.count() > 0) await tap(page, languages.locator('button.title'), 'Open language choices')
        await inspect(page, doc, 'language-options', 'shared-component', options)
        const language = options.getByRole('link', { name: locale === 'root' ? 'English' : '简体中文', exact: true })
        const languageUrl = new URL((await language.getAttribute('href'))!, page.url())
        await tap(page, language, 'Switch documentation language')
        await page.waitForURL(languageUrl.href)
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale === 'root' ? 'en-US' : 'zh-CN')
        // The flyout's `open` state survives the SPA navigation and would keep
        // covering the landed page's controls during the audit.
        await closeAppearance(page)
        await inspect(page, doc, 'language-switched', 'shared-component', page.locator('.VPContent'), ['language-navigation'])
        await page.goto(origin + routeLink(doc.route), { waitUntil: 'networkidle' })
        const outline = page.locator('.VPLocalNavOutlineDropdown')
        await tap(page, outline.locator('button'), 'Open page outline')
        const outlineItems = outline.locator('.items')
        await outlineItems.waitFor()
        await inspect(page, doc, 'outline-open', 'shared-component', outlineItems)
        const headingLink = outlineItems.locator('a.outline-link').first()
        const headingUrl = new URL((await headingLink.getAttribute('href'))!, page.url())
        await tap(page, headingLink, 'Follow page heading')
        await page.waitForURL(headingUrl.href)
        await outlineItems.waitFor({ state: 'hidden' })
        await inspect(page, doc, 'outline-heading-opened', 'shared-component', page.locator('.VPContent'), ['heading-navigation'])
        await tap(page, outline.locator('button'), 'Reopen page outline')
        await tap(page, outlineItems.locator('.top-link'), 'Return to page top')
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
        await outlineItems.waitFor({ state: 'hidden' })
        await inspect(page, doc, 'outline-returned-to-top', 'shared-component', page.locator('.VPContent'), ['outline-top-action'])
        const menu = page.locator('.VPLocalNav button.menu')
        if (await menu.isVisible()) {
          await tap(page, menu, 'Open documentation sidebar')
          await expect.poll(() => menu.getAttribute('aria-expanded')).toBe('true')
          const sidebar = page.locator('.VPSidebar')
          await inspect(page, doc, 'sidebar-open', 'shared-component', sidebar)
          const links = sidebar.locator('a[href]').filter({ visible: true })
          const index = await links.evaluateAll(items => items.findIndex(item => item instanceof HTMLAnchorElement
            && item.origin === location.origin && item.pathname !== location.pathname))
          expect(index).toBeGreaterThanOrEqual(0)
          const link = links.nth(index)
          const target = new URL((await link.getAttribute('href'))!, page.url())
          await tap(page, link, 'Follow sidebar link')
          await page.waitForURL(target.href)
          await expect.poll(() => page.locator('.VPLocalNav button.menu').getAttribute('aria-expanded')).toBe('false')
          await inspect(page, doc, 'sidebar-link-opened', 'shared-component', page.locator('.VPContent'), ['sidebar-navigation'])
          await page.goto(origin + routeLink(doc.route), { waitUntil: 'networkidle' })
        }
        expect(errors).toEqual([])
        cases.push({ route: doc.route, scenario: 'shared-navigation-theme-language', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: doc.route, scenario: 'shared-navigation-theme-language', viewport: { width, height }, status: 'failed', error: String(error) })
        throw error
      } finally { await page.close() }
    })
    it.each(viewports)(`${locale} shared search states at %i×%i`, async (width, height) => {
      const { page, errors } = await open(doc, width, height)
      try {
        await searchStates(page, doc)
        expect(errors).toEqual([])
        cases.push({ route: doc.route, scenario: 'shared-search', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: doc.route, scenario: 'shared-search', viewport: { width, height }, status: 'failed', error: String(error) })
        throw error
      } finally { await page.close() }
    })
    it.each(viewports)(`${locale} shared Markdown actions at %i×%i`, async (width, height) => {
      const { page, errors, copied } = await open(doc, width, height, true)
      try {
        await markdownLink(page, doc, 'shared-component')
        await markdownCopyStates(page, doc, copied)
        expect(errors).toEqual([])
        cases.push({ route: doc.route, scenario: 'shared-markdown', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: doc.route, scenario: 'shared-markdown', viewport: { width, height }, status: 'failed', error: String(error) })
        throw error
      } finally { await page.close() }
    })
    const codeDoc = docsPages.find(candidate => candidate.locale === locale && candidate.route.endsWith('guide/providers.md'))!
    it.each(viewports)(`${locale} shared code copy at %i×%i`, async (width, height) => {
      const { page, errors, copied } = await open(codeDoc, width, height, true)
      try {
        const block = page.locator('.vp-doc div.language-yaml').first()
        const expected = readFileSync(join(repository, codeDoc.source), 'utf8').match(/^```yaml[^\n]*\n([\s\S]*?)^```\s*$/m)?.[1]
        expect(expected).toBeDefined()
        const copy = block.locator('button.copy')
        await tap(page, copy, 'Copy documented configuration')
        await expect.poll(() => copied.length).toBe(1)
        expect(copied[0]?.text.trim()).toBe(expected!.trim())
        expect(copied[0]?.active).toBe(true)
        await expect.poll(() => copy.evaluate(element => element.classList.contains('copied'))).toBe(true)
        await inspect(page, codeDoc, 'code-copy-succeeded', 'shared-component', block, ['canonical-code-bytes', 'clipboard-adapter', 'trusted-user-activation'])
        expect(errors).toEqual([])
        cases.push({ route: codeDoc.route, scenario: 'shared-code-copy', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: codeDoc.route, scenario: 'shared-code-copy', viewport: { width, height }, status: 'failed', error: String(error) })
        throw error
      } finally { await page.close() }
    })
    const diagramDoc = docsPages.find(candidate => candidate.locale === locale
      && (diagramCounts.get(candidate.route) ?? 0) > 0)
    if (diagramDoc === undefined) throw new Error(`No published ${locale} diagram page for shared viewer acceptance`)
    it.each(viewports)(`${locale} shared diagram zoom/pan/fit/help/close at %i×%i`, async (width, height) => {
      const { page, errors } = await open(diagramDoc, width, height)
      try {
        await diagramState(page, diagramDoc, 0, true)
        expect(errors).toEqual([])
        cases.push({ route: diagramDoc.route, scenario: 'shared-diagram', viewport: { width, height }, status: 'passed' })
      } catch (error) {
        cases.push({ route: diagramDoc.route, scenario: 'shared-diagram', viewport: { width, height }, status: 'failed', error: String(error) })
        throw error
      }
      finally { await page.close() }
    })
  }
})
