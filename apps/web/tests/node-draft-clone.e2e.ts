/** Tab duplication and node-owned draft recovery through the shipped browser UI and private SQLite store. @module */
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { computerBrowser } from './computer-browser.ts'
import { expect, it } from 'vitest'
import { launchPersonalComputersFixture } from './personal-computers-fixture.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'

const composer = (page: Page) => page.locator('textarea:enabled').last()

async function open(page: Page, name: string): Promise<void> {
  const computer = page.getByRole('region', { name: name + ' computer', exact: true })
  const heading = computer.getByRole('button', { name: name + ' computer', exact: true })
  if (await heading.getAttribute('aria-expanded') !== 'true') await heading.click()
  const conversation = computer.getByText(name + ' conversation', { exact: true })
  if (!await conversation.isVisible()) await computer.getByText(name + ' work', { exact: true }).click()
  await conversation.click()
}

async function pointer(page: Page): Promise<string | undefined> {
  return page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith('.node-draft.v1'))
    .map(key => sessionStorage.getItem(key)).find((item): item is string => item !== null && item.includes('@')))
}

it('duplicates a pinned draft before a sibling edit, reloads it unedited, and saves independently on its original computer', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await computerBrowser()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  const original = await context.newPage()
  let readingCopy = false
  const release = Promise.withResolvers<undefined>()
  try {
    await original.goto(fixture.url, { waitUntil: 'networkidle' })
    await open(original, 'Compute')
    await original.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    await composer(original).fill('Copied version')
    await expect.poll(() => pointer(original)).toBeDefined()
    const first = (await pointer(original))!
    const id = first.slice(0, first.indexOf('@'))
    await context.route('**/account/api/drafts/**', async (route) => {
      const request = route.request()
      if (request.method() === 'GET' && request.frame().page() !== original && new URL(request.url()).pathname.endsWith('/' + id)) {
        readingCopy = true
        await release.promise
      }
      await route.continue()
    })
    const popup = original.waitForEvent('popup')
    await original.evaluate(() => { window.open(location.href, '_blank') })
    const copy = await popup
    await expect.poll(() => readingCopy, { timeout: 25_000 }).toBe(true)
    await composer(original).fill('Original tab change')
    await expect.poll(() => pointer(original)).not.toBe(first)
    release.resolve(undefined)
    await expect.poll(() => composer(copy).inputValue()).toBe('Copied version')
    await expect.poll(async () => { const saved = await pointer(copy); return saved !== undefined && saved.split('@')[0] !== id }).toBe(true)
    expect(await pointer(copy)).toBeDefined()
    await copy.reload({ waitUntil: 'networkidle' })
    await expect.poll(() => composer(copy).inputValue()).toBe('Copied version')
    await composer(copy).fill('Independent copy change')
    await expect.poll(async () => (await pointer(copy))?.endsWith('@2')).toBe(true)
    expect(await composer(original).inputValue()).toBe('Original tab change')
    const durable = fixture.draftReceipts.filter(row => row.method === 'PUT' && row.status === 200)
    expect(new Set(durable.map(row => row.node))).toEqual(new Set([1]))
    expect(new Set(durable.map(row => row.slot)).size).toBe(2)
    for (const page of [copy, original]) {
      expect(await page.evaluate(() => [sessionStorage, localStorage].flatMap(store => Object.keys(store)
        .map(key => store.getItem(key))).some(value => value?.includes('Copied version') || value?.includes('tab change') || value?.includes('copy change')))).toBe(false)
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/personal-computers/duplicate-draft.expected.md', import.meta.url)),
      `Original tab holds “${await composer(original).inputValue()}”.\nCopied tab holds “${await composer(copy).inputValue()}”.`, webSnapshotMode())
  } finally { release.resolve(undefined); await browser.close(); await fixture.close() }
}, 120_000)

it('retries the saved draft on its original computer using the pending conversation card after a temporary read failure', async () => {
  const fixture = await launchPersonalComputersFixture()
  const browser = await computerBrowser()
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
  try {
    await page.goto(fixture.url, { waitUntil: 'networkidle' })
    await open(page, 'Compute')
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    await composer(page).fill('Draft from Compute')
    await expect.poll(() => pointer(page)).toBeDefined()
    const saved = (await pointer(page))!
    const id = saved.slice(0, saved.indexOf('@'))
    await open(page, 'Office')
    await page.locator('[data-conversation-intent]').waitFor({ state: 'hidden' })
    await page.reload({ waitUntil: 'networkidle' })
    let offline = true, reads = 0
    await page.route('**/account/api/drafts/**', async (route) => {
      if (route.request().method() === 'GET' && new URL(route.request().url()).pathname.endsWith('/' + id)) {
        reads++
        if (offline) return route.fulfill({ status: 503 })
      }
      await route.continue()
    })
    await open(page, 'Compute')
    const card = page.locator('[data-conversation-intent]')
    await card.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    offline = false
    await card.getByRole('button', { name: 'Retry', exact: true }).click()
    await card.waitFor({ state: 'hidden' })
    await expect.poll(() => composer(page).inputValue()).toBe('Draft from Compute')
    expect(reads).toBeGreaterThanOrEqual(2)
  } finally { await browser.close(); await fixture.close() }
}, 120_000)
