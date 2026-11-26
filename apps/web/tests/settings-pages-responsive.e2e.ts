/** Every settings section and its staged forms through the real Web composition. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, JSHandle, Locator, Page } from 'playwright'
import type { ShortcutBinding, ShortcutDocument } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName, responsiveMobileEmulation } from './responsive-browser.ts'
import { auditResponsiveState } from './responsive-state.ts'
import { auditResponsiveControl } from './responsive-controls.ts'
import { saveFailureShot } from './support.ts'

const desktop = { width: 1280, height: 900 }
const receipts: { state: string; dimensions: number }[] = []
const shortcutStorageKey = 'dsh.keybindings.v1'
const shortcutCommand = 'Open keyboard shortcuts'

interface ShortcutStorageFaults {
  arm(kind: 'read' | 'write'): void
  refused(): { read: number; write: number }
  restore(): void
}

/** Refuse one exact-key storage operation in this disposable page, then restore its native methods. */
async function withShortcutStorageFaults(page: Page, run: (faults: JSHandle<ShortcutStorageFaults>) => Promise<void>): Promise<void> {
  const faults = await page.evaluateHandle((key): ShortcutStorageFaults => {
    const get = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')!
    const set = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!
    const read = get.value as (this: Storage, name: string) => string | null
    const write = set.value as (this: Storage, name: string, value: string) => void
    const pending = { read: false, write: false }
    const refused = { read: 0, write: 0 }
    Object.defineProperty(Storage.prototype, 'getItem', { ...get, value: function (this: Storage, name: string): string | null {
      if (this === localStorage && name === key && pending.read) {
        pending.read = false; refused.read++
        throw new DOMException('Shortcut storage read refused by the browser fixture', 'SecurityError')
      }
      return read.call(this, name)
    } })
    Object.defineProperty(Storage.prototype, 'setItem', { ...set, value: function (this: Storage, name: string, value: string): void {
      if (this === localStorage && name === key && pending.write) {
        pending.write = false; refused.write++
        throw new DOMException('Shortcut storage write refused by the browser fixture', 'QuotaExceededError')
      }
      write.call(this, name, value)
    } })
    return {
      arm(kind) { pending[kind] = true },
      refused() { return { ...refused } },
      restore() { Object.defineProperty(Storage.prototype, 'getItem', get); Object.defineProperty(Storage.prototype, 'setItem', set) },
    }
  }, shortcutStorageKey)
  try { await run(faults) }
  finally { try { await faults.evaluate((value) =>{  value.restore() }) } finally { await faults.dispose() } }
}

async function shortcutRaw(page: Page): Promise<string | null> {
  return page.evaluate(key => localStorage.getItem(key), shortcutStorageKey)
}

async function shortcutOverrides(page: Page): Promise<Readonly<Record<string, ShortcutBinding | null>>> {
  const raw = await shortcutRaw(page)
  expect(raw).not.toBeNull()
  const document = JSON.parse(raw!) as ShortcutDocument
  const profiles = Object.values(document.profiles)
  expect(profiles).toHaveLength(1)
  return profiles[0]!
}

function shiftedShortcut(code: 'Comma' | 'Period', primary: 'Meta' | 'Control'): ShortcutBinding {
  return { code, modifiers: primary === 'Meta' ? ['shift', 'meta'] : ['control', 'shift'] }
}

async function openShortcuts(page: Page): Promise<{ dialog: Locator; primary: 'Meta' | 'Control' }> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const entry = page.getByRole('button', { name: 'Edit shortcuts', exact: true })
  await expect.poll(() => entry.getAttribute('aria-keyshortcuts')).toMatch(/(?:^|\+)(Meta|Control)\+/u)
  const binding = await entry.getAttribute('aria-keyshortcuts')
  const primary = binding!.split('+').includes('Meta') ? 'Meta' : 'Control'
  await entry.click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
  await dialog.waitFor()
  return { dialog, primary }
}

async function recordShortcut(dialog: Locator, command: string, combination: string): Promise<void> {
  const row = dialog.getByRole('button', { name: `Edit shortcut for ${command}`, exact: true })
  await row.click()
  await dialog.getByRole('button', { name: 'Press a shortcut', exact: true }).press(combination)
  await row.waitFor()
}

async function expectShortcutFeedback(page: Page, message: Locator): Promise<void> {
  await auditResponsiveControl(page, message, 'shortcuts/persistent-feedback', 'center')
  const overflow = await message.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element)
    const text = range.getBoundingClientRect()
    return Math.max(box.left - text.left, text.right - box.right, box.top - text.top, text.bottom - box.bottom)
  })
  expect(overflow).toBeLessThanOrEqual(1)
}

describe('web e2e: every settings section at responsive boundaries', () => {
  let world: WebScaffold
  let browser: Browser
  beforeAll(async () => {
    world = await launchWebScaffold({
      deepSeekSearch: { apiKeyEnv: 'DSH_RESPONSIVE_UNUSED_WEB_KEY' },
      deepSeekWebApi: { apiKeyEnv: 'DSH_RESPONSIVE_UNUSED_WEB_KEY' },
    })
    browser = await responsiveBrowser.launch()
  }, 120_000)
  afterAll(async () => {
    try {
      const output = process.env.DSH_MOBILE_SCREENSHOTS
      if (output) {
        await mkdir(output, { recursive: true })
        await writeFile(join(output, `settings-pages-${responsiveBrowserName}.json`), JSON.stringify(receipts, null, 2) + '\n')
      }
    } finally { try { await browser?.close() } finally { await world?.close() } }
  })

  async function open(): Promise<Page> {
    const page = await browser.newPage({ viewport: desktop, hasTouch: true, isMobile: responsiveMobileEmulation,
      locale: 'en-US', reducedMotion: 'reduce' })
    await page.goto(world.authenticatedUrl)
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
    return page
  }

  async function audit(page: Page, surface: Locator, state: string, verify?: () => Promise<void>): Promise<void> {
    receipts.push(await auditResponsiveState(page, surface, state, verify))
  }

  it('keeps every section, general preference menu and expanded font controls reachable', async () => {
    const page = await open()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.waitFor()
      const sections = ['General', 'Models', 'Built-in plugins', 'Agent presets', 'Archived sessions']
      expect(await dialog.getByRole('navigation').getByRole('button').count()).toBe(sections.length)
      for (const name of sections) {
        const tab = dialog.getByRole('navigation').getByRole('button', { name, exact: true })
        await tab.click()
        await expect.poll(() => tab.getAttribute('aria-current')).toBe('true')
        await audit(page, dialog, name.toLowerCase().replaceAll(' ', '-'))
      }
      await dialog.getByRole('navigation').getByRole('button', { name: 'General', exact: true }).click()
      await dialog.getByRole('button', { name: 'More font settings', exact: true }).click()
      await audit(page, dialog, 'expanded-fonts', async () => {
        for (const name of ['Text font', 'Code font', 'Terminal font']) {
          const geometry = await dialog.getByRole('textbox', { name, exact: true }).evaluate((element) => {
            const field = element.parentElement!.getBoundingClientRect()
            const row = element.parentElement!.parentElement!
            const label = row.firstElementChild!.getBoundingClientRect()
            return { width: row.getBoundingClientRect().width, labelWidth: label.width, gap: field.top - label.bottom }
          })
          if (geometry.width <= 400) {
            expect(geometry.labelWidth).toBeGreaterThanOrEqual(geometry.width - 1)
            expect(geometry.gap).toBeGreaterThanOrEqual(0)
          }
        }
      })
      for (const name of ['Standard mode', 'Workspace Write', 'English', 'Built-in browser', 'Queue']) {
        await dialog.getByRole('button', { name, exact: true }).click()
        const menu = page.getByRole('menu').last()
        await menu.waitFor()
        await audit(page, menu, 'menu-' + name.toLowerCase().replaceAll(' ', '-'))
        await page.keyboard.press('Escape')
      }
      await dialog.getByRole('button', { name: 'Edit shortcuts', exact: true }).click()
      const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
      await audit(page, shortcuts, 'shortcuts', async () => {
        const geometry = await shortcuts.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return { width: innerWidth, cardWidth: box.width, top: box.top, bottom: innerHeight - box.bottom }
        })
        expect(geometry.top).toBeGreaterThanOrEqual(0)
        expect(geometry.bottom).toBeGreaterThanOrEqual(-1)
        if (geometry.width >= 768) expect(Math.abs(geometry.top - geometry.bottom)).toBeLessThanOrEqual(1)
        else expect(Math.abs(geometry.cardWidth - geometry.width)).toBeLessThanOrEqual(1)
      })
      expect(errors).toEqual([])
    } catch (error) { console.log(error); await saveFailureShot(page, `settings-sections-${responsiveBrowserName}`); throw error }
    finally { await page.close() }
  }, 480_000)

  it('keeps shortcut search, recording, validation and reset confirmation reachable', async () => {
    const page = await open()
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Edit shortcuts', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
      const search = dialog.getByRole('searchbox', { name: 'Search shortcuts', exact: true })
      await search.fill('no-matching-shortcut-abcdefghijklmnopqrstuvwxyz')
      await dialog.getByText('No matching shortcuts', { exact: true }).waitFor()
      await audit(page, dialog, 'shortcuts-empty-search')
      await dialog.getByRole('button', { name: 'Clear search', exact: true }).click()
      await search.fill('shortcut')
      await dialog.getByRole('button', { name: /^Edit shortcut for / }).first().click()
      const recorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
      await recorder.waitFor()
      await audit(page, dialog, 'shortcuts-recording')
      await recorder.press('a')
      await expect.poll(() => recorder.getAttribute('aria-invalid')).toBe('true')
      const recordingError = dialog.getByText('Include Command, Ctrl, or Alt in the combination.', { exact: true })
      await recordingError.waitFor({ state: 'visible' })
      await page.getByRole('alert').waitFor({ state: 'hidden' })
      await audit(page, dialog, 'shortcuts-invalid-recording', async () => {
        await recordingError.waitFor({ state: 'visible' })
        await auditResponsiveControl(page, recordingError, 'shortcuts/persistent-recording-error', 'center')
        const geometry = await recordingError.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const text = document.createRange()
          text.selectNodeContents(element)
          const content = text.getBoundingClientRect()
          const style = getComputedStyle(element)
          return { height: box.height, lineHeight: Number.parseFloat(style.lineHeight), clipPath: style.clipPath,
            overflow: Math.max(box.left - content.left, content.right - box.right, box.top - content.top, content.bottom - box.bottom) }
        })
        expect(geometry.clipPath).toBe('none')
        expect(geometry.height).toBeGreaterThanOrEqual(geometry.lineHeight)
        expect(geometry.overflow).toBeLessThanOrEqual(1)
      })
      await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
      const reset = dialog.getByRole('button', { name: 'Restore all defaults', exact: true })
      await expect.poll(() => reset.isEnabled()).toBe(true)
      await audit(page, dialog, 'shortcuts-customized')
      await reset.click()
      const confirmation = page.getByRole('dialog', { name: 'Restore all default shortcuts?', exact: true })
      await audit(page, confirmation, 'shortcuts-reset-confirmation')
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await reset.click()
      await confirmation.getByRole('button', { name: 'Restore default', exact: true }).click()
      await expect.poll(() => reset.isDisabled()).toBe(true)
    } catch (error) { await saveFailureShot(page, `settings-shortcuts-${responsiveBrowserName}`); throw error }
    finally { await page.close() }
  }, 480_000)

  it('retains the shortcut binding after a conflict and accepts a different combination', async () => {
    const page = await open()
    try {
      const { dialog, primary } = await openShortcuts(page)
      const previous = await shortcutRaw(page)
      await dialog.getByRole('button', { name: 'Edit shortcut for Open settings', exact: true }).click()
      const recorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
      await recorder.press(`${primary}+Slash`)
      const message = dialog.getByText(`Already used by “${shortcutCommand}”`, { exact: true })
      await message.waitFor()
      expect(await recorder.getAttribute('aria-invalid')).toBe('true')
      expect(await shortcutRaw(page)).toBe(previous)
      await page.getByRole('alert').waitFor({ state: 'hidden' })
      await audit(page, dialog, 'shortcuts-binding-conflict', () => expectShortcutFeedback(page, message))
      await recorder.press(`${primary}+Shift+Period`)
      await dialog.getByRole('button', { name: 'Edit shortcut for Open settings', exact: true }).waitFor()
      expect((await shortcutOverrides(page))['settings.open']).toEqual(shiftedShortcut('Period', primary))
    } catch (error) { await saveFailureShot(page, `settings-shortcuts-conflict-${responsiveBrowserName}`); throw error }
    finally { await page.close() }
  }, 480_000)

  it('requires shortcut revision review after a real write from another page and preserves both edits', async () => {
    const context = await browser.newContext({ viewport: desktop, hasTouch: true, isMobile: responsiveMobileEmulation,
      locale: 'en-US', reducedMotion: 'reduce' })
    try {
      const first = await context.newPage()
      const second = await context.newPage()
      try {
        await first.goto(world.authenticatedUrl)
        const { dialog, primary } = await openShortcuts(first)
        await dialog.getByRole('button', { name: 'Edit shortcut for Open settings', exact: true }).click()
        await second.goto(world.authenticatedUrl)
        const other = await openShortcuts(second)
        await recordShortcut(other.dialog, shortcutCommand, `${other.primary}+Shift+Period`)
        const otherWrite = await shortcutRaw(second)
        await first.bringToFront()
        const review = dialog.getByRole('button', { name: 'I have reviewed the latest configuration', exact: true })
        await review.waitFor()
        await dialog.getByRole('button', { name: 'Press a shortcut', exact: true }).press(`${primary}+Shift+Comma`)
        const editor = dialog.getByRole('group', { name: 'Open settings', exact: true })
        expect(await editor.getByRole('button', { name: 'Restore default', exact: true }).isDisabled()).toBe(true)
        expect(await shortcutRaw(first)).toBe(otherWrite)
        await first.getByRole('alert').waitFor({ state: 'hidden' })
        await audit(first, dialog, 'shortcuts-external-revision-review', async () => {
          await auditResponsiveControl(first, review, 'shortcuts/review-latest-configuration', 'center')
          expect(await editor.getByRole('button', { name: 'Restore default', exact: true }).isDisabled()).toBe(true)
        })
        await review.click()
        await dialog.getByRole('button', { name: 'Retry save', exact: true }).click()
        await dialog.getByRole('button', { name: 'Edit shortcut for Open settings', exact: true }).waitFor()
        expect(await shortcutOverrides(first)).toEqual({
          'shortcuts.open': shiftedShortcut('Period', primary),
          'settings.open': shiftedShortcut('Comma', primary),
        })
        expect(await shortcutRaw(second)).toBe(await shortcutRaw(first))
      } catch (error) { await saveFailureShot(first, `settings-shortcuts-revision-${responsiveBrowserName}`); throw error }
    } finally { await context.close() }
  }, 480_000)

  it('retains accepted shortcut bindings after a storage read failure and recovers by reloading', async () => {
    const page = await open()
    try {
      const { dialog, primary } = await openShortcuts(page)
      await recordShortcut(dialog, shortcutCommand, `${primary}+Shift+Period`)
      const previous = await shortcutRaw(page)
      await withShortcutStorageFaults(page, async (faults) => {
        await dialog.getByRole('button', { name: 'Edit shortcut for Open settings', exact: true }).click()
        await faults.evaluate((value) =>{  value.arm('read') })
        const recorder = dialog.getByRole('button', { name: 'Press a shortcut', exact: true })
        await recorder.press(`${primary}+Shift+Comma`)
        const review = dialog.getByRole('button', { name: 'I have reviewed the latest configuration', exact: true })
        await review.waitFor()
        await review.click()
        await recorder.press(`${primary}+Shift+Comma`)
        const message = dialog.getByText('Could not read this site’s localStorage entry dsh.keybindings.v1. Check access permissions, then reload the page. The last successfully read bindings remain active.', { exact: true })
        await message.waitFor()
        expect(await shortcutRaw(page)).toBe(previous)
        expect(await faults.evaluate(value => value.refused())).toEqual({ read: 1, write: 0 })
        await page.getByRole('alert').waitFor({ state: 'hidden' })
        await audit(page, dialog, 'shortcuts-storage-read-failed', async () => {
          await expectShortcutFeedback(page, message)
          expect(await dialog.getByRole('button', { name: 'Restore all defaults', exact: true }).isDisabled()).toBe(true)
        })
        await page.keyboard.press('Escape')
        await dialog.getByRole('button', { name: 'Close keyboard shortcuts', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        await page.keyboard.press(`${primary}+Shift+Period`)
        await dialog.waitFor()
        expect(await shortcutRaw(page)).toBe(previous)
      })
      await page.reload()
      const recovered = await openShortcuts(page)
      expect(await shortcutRaw(page)).toBe(previous)
      await recordShortcut(recovered.dialog, 'Open settings', `${recovered.primary}+Shift+Comma`)
      expect(await shortcutOverrides(page)).toEqual({
        'shortcuts.open': shiftedShortcut('Period', primary),
        'settings.open': shiftedShortcut('Comma', primary),
      })
    } catch (error) { await saveFailureShot(page, `settings-shortcuts-read-${responsiveBrowserName}`); throw error }
    finally { await page.close() }
  }, 480_000)

  it('retains shortcut drafts and accepted bindings after save and reset failures until retry succeeds', async () => {
    const page = await open()
    try {
      const { dialog, primary } = await openShortcuts(page)
      await withShortcutStorageFaults(page, async (faults) => {
        const previous = await shortcutRaw(page)
        await dialog.getByRole('button', { name: `Edit shortcut for ${shortcutCommand}`, exact: true }).click()
        await faults.evaluate((value) =>{  value.arm('write') })
        await dialog.getByRole('button', { name: 'Press a shortcut', exact: true }).press(`${primary}+Shift+Period`)
        const message = dialog.getByText('Could not save. Your previous shortcuts and current draft are preserved. Please retry.', { exact: true })
        await message.waitFor()
        expect(await shortcutRaw(page)).toBe(previous)
        expect(await faults.evaluate(value => value.refused())).toEqual({ read: 0, write: 1 })
        await page.getByRole('alert').waitFor({ state: 'hidden' })
        await audit(page, dialog, 'shortcuts-storage-write-failed', () => expectShortcutFeedback(page, message))
        await dialog.getByRole('button', { name: 'Retry save', exact: true }).click()
        await dialog.getByRole('button', { name: `Edit shortcut for ${shortcutCommand}`, exact: true }).waitFor()
        expect((await shortcutOverrides(page))['shortcuts.open']).toEqual(shiftedShortcut('Period', primary))
        const accepted = await shortcutRaw(page)
        const reset = dialog.getByRole('button', { name: 'Restore all defaults', exact: true })
        await reset.click()
        const confirmation = page.getByRole('dialog', { name: 'Restore all default shortcuts?', exact: true })
        const confirm = confirmation.getByRole('button', { name: 'Restore default', exact: true })
        let resetRefusals = 0
        const output = process.env.DSH_MOBILE_SCREENSHOTS
        if (output) await mkdir(output, { recursive: true })
        await audit(page, confirmation, 'shortcuts-reset-failed', async () => {
          await page.getByRole('alert').waitFor({ state: 'hidden' })
          await faults.evaluate((value) =>{  value.arm('write') })
          await confirm.click()
          resetRefusals++
          const feedback = page.getByRole('alert').filter({ hasText: 'Could not restore defaults. Your shortcuts are unchanged. Please retry.' })
          await feedback.waitFor()
          await expect.poll(() => feedback.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
          expect(await confirmation.isVisible()).toBe(true)
          expect(await shortcutRaw(page)).toBe(accepted)
          expect(await faults.evaluate(value => value.refused())).toEqual({ read: 0, write: 1 + resetRefusals })
          const geometry = await feedback.evaluate((element) => {
            const box = element.getBoundingClientRect()
            const text = document.createRange()
            text.selectNodeContents(element)
            const content = text.getBoundingClientRect()
            return { overflow: Math.max(-box.left, box.right - innerWidth, -box.top, box.bottom - innerHeight,
              box.left - content.left, content.right - box.right, box.top - content.top, content.bottom - box.bottom),
            width: innerWidth, height: innerHeight }
          })
          expect(geometry.overflow).toBeLessThanOrEqual(1)
          // Finishing animations would hide this transient announcement before capture.
          if (output) await page.screenshot({ path: join(output,
            `${responsiveBrowserName}-shortcuts-reset-failed-${String(geometry.width)}x${String(geometry.height)}-feedback.png`), animations: 'allow' })
        })
        await confirm.click()
        await confirmation.waitFor({ state: 'hidden' })
        expect(await reset.isDisabled()).toBe(true)
        expect(await shortcutOverrides(page)).toEqual({})
      })
    } catch (error) { await saveFailureShot(page, `settings-shortcuts-write-reset-${responsiveBrowserName}`); throw error }
    finally { await page.close() }
  }, 480_000)

  it('keeps adopted and custom provider forms, validation and deletion confirmation usable', async () => {
    const page = await open()
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'Models', exact: true }).click()
      await dialog.getByRole('button', { name: 'Add provider', exact: true }).click()
      const provider = dialog.getByRole('combobox', { name: 'Provider', exact: true })
      await provider.selectOption('minimax-cn')
      await audit(page, dialog, 'adopt-provider')
      const key = dialog.getByLabel('API key', { exact: true })
      await key.fill('invalid-😀-fixture-key')
      await expect.poll(() => dialog.getByRole('button', { name: 'Apply', exact: true }).isDisabled()).toBe(true)
      await audit(page, dialog, 'provider-invalid-key')
      await key.fill('')
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
      await dialog.getByRole('button', { name: 'Edit minimax-cn', exact: true }).waitFor()
      await audit(page, dialog, 'provider-saved')
      await dialog.getByRole('button', { name: 'Delete minimax-cn', exact: true }).click()
      const confirmation = page.getByRole('dialog', { name: 'Delete minimax-cn?', exact: true })
      await confirmation.waitFor()
      await audit(page, confirmation, 'delete-provider')
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.getByRole('button', { name: 'Add provider', exact: true }).click()
      await dialog.getByRole('tab', { name: 'Custom', exact: true }).click()
      const custom = dialog.locator('#models-add-custom-panel')
      await custom.getByLabel('Provider ID', { exact: true }).fill('responsive-provider')
      await custom.getByLabel('Display name', { exact: true }).fill('Long provider display name for narrow settings layouts')
      await custom.getByLabel('Base URL', { exact: true }).fill('https://example.invalid/very-long-provider-endpoint/v1')
      await audit(page, dialog, 'custom-provider')
    } catch (error) { await saveFailureShot(page, `settings-providers-${responsiveBrowserName}`); console.log(await page.locator('body').ariaSnapshot()); throw error }
    finally { await page.close() }
  }, 480_000)

  it('opens every exposed plugin configuration detail and all optional plugin cards', async () => {
    const page = await open()
    try {
      await page.getByRole('navigation', { name: 'Panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.waitFor()
      const group = panel.locator('[data-plugin-group="basic"]')
      await group.getByRole('button', { name: 'View Terminal', exact: true }).waitFor()
      const names = await group.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''))
      await audit(page, panel, 'plugin-configuration-list')
      for (const name of names.filter(name => name.startsWith('View '))) {
        await group.getByRole('button', { name, exact: true }).click()
        const detail = panel.locator('[data-plugin-item-detail]')
        await detail.waitFor()
        await audit(page, detail, 'plugin-' + name.slice(5).toLowerCase().replaceAll(/[^a-z0-9]/g, '-'))
        await panel.getByRole('button', { name: 'Back to plugins', exact: true }).click()
      }
      await page.getByRole('button', { name: 'More', exact: true }).click()
      await audit(page, panel, 'optional-plugins')
    } catch (error) { await saveFailureShot(page, `settings-plugins-${responsiveBrowserName}`); console.log(await page.locator('body').ariaSnapshot()); throw error }
    finally { await page.close() }
  }, 480_000)
})
