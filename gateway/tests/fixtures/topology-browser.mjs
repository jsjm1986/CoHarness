/** Real assembled Web/Admin mode matrix using the caller's isolated Chromium. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { adminProjectBrowser } from './admin-project-browser.mjs'
import { adminDetachmentBrowser } from './admin-detachment-browser.mjs'

/** Keep two primary tabs open through a policy change while closing foreign connections before detach. */
export async function topologyBrowser({ primary, secondary, primaryCookie, remoteCookie, secondaryCookie, localRuntime, remoteRuntime, workspaceName,
  unifiedRuntime, unifiedWorkspace, verifyUnifiedPassive, verifyUnifiedStarted, verifyAdminProjectPassive }) {
  const module = process.env.HGW_TOPOLOGY_BROWSER_MODULE
  if (module === undefined) return { afterDisable: async () => {}, close: async () => {} }
  const { chromium } = await import(pathToFileURL(resolve(module)).href)
  const browser = await chromium.launch({ headless: true, executablePath: process.env.HGW_TOPOLOGY_BROWSER_EXECUTABLE })
  const screenshots = process.env.HGW_TOPOLOGY_SCREENSHOTS
  if (screenshots !== undefined) await mkdir(screenshots, { recursive: true })
  const contexts = []
  const session = async (origin, cookie) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    contexts.push(context)
    const separator = cookie.indexOf('=')
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin },
      { name: 'hgw_lang', value: 'zh', url: origin }])
    return context
  }
  const capture = async (page, name, fullPage = true) => {
    await page.waitForFunction(() => document.fonts.status === 'loaded')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(overflow, false, `${name} must fit its viewport`)
    if (screenshots !== undefined) await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage, animations: 'disabled' })
  }
  try {
    const context = await session(primary, primaryCookie)
    const policyReads = []
    context.on('response', response => { if (response.url().includes('/account/api/deployment/context')) policyReads.push(response.status()) })
    const first = await context.newPage(), second = await context.newPage()
    for (const page of [first, second]) {
      await page.goto(`${primary}/?dshRuntime=${localRuntime}`)
      const postpone = page.getByRole('button', { name: '稍后配置', exact: true })
      try { await postpone.click({ timeout: 2000 }) } catch (error) { if (error.name !== 'TimeoutError') throw error }
      const composer = page.locator('textarea').first()
      await composer.waitFor({ state: 'visible', timeout: 60000 })
      if (!await composer.isEditable()) {
        await composer.click()
        await page.getByRole('menuitem').filter({ hasText: workspaceName }).first().click()
        await page.waitForFunction(() => { const field = document.querySelector('textarea'); return field !== null && !field.readOnly })
      }
      const model = page.getByRole('button', { name: '选择模型', exact: true })
      if (await model.count() > 0) {
        await model.click()
        const sub = page.getByRole('menuitem', { name: /模型/ })
        if (await sub.count() > 0) await sub.click()
        await page.getByRole('menuitemradio').first().click()
        await page.keyboard.press('Escape')
      }
    }
    const input = page => page.locator('textarea').first()
    await first.waitForFunction(() => document.querySelector('[aria-label="工作电脑"]') !== null, undefined, { timeout: 10000 }).catch(error => { throw new Error(`Computer identity did not render; policy reads: ${JSON.stringify(policyReads)}`, { cause: error }) })
    await input(first).fill('第一标签页保留的草稿')
    await input(second).fill('第二标签页独立的草稿')
    assert.equal(await input(first).inputValue(), '第一标签页保留的草稿')
    assert.equal(await input(second).inputValue(), '第二标签页独立的草稿')
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await first.setViewportSize({ width, height: 1000 }); await first.emulateMedia({ colorScheme })
      await capture(first, `primary-${width}-${colorScheme}`)
    }
    await first.setViewportSize({ width: 1440, height: 1000 })
    const remoteContext = await session(primary, remoteCookie)
    const remote = await remoteContext.newPage()
    const connected = remote.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list', { timeout: 60000 })
    await remote.goto(`${primary}/?dshRuntime=${remoteRuntime}`)
    assert.equal((await (await connected).json()).result.ok, true)
    await remote.locator('[aria-label="工作电脑"]:visible').waitFor({ timeout: 30000 })
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await remote.setViewportSize({ width, height: 1000 }); await remote.emulateMedia({ colorScheme })
      await capture(remote, `remote-through-primary-${width}-${colorScheme}`)
    }
    assert.equal(await input(first).inputValue(), '第一标签页保留的草稿')
    assert.equal(await input(second).inputValue(), '第二标签页独立的草稿')
    await remoteContext.close()
    const unifiedContext = await session(primary, primaryCookie)
    const unifiedA = await unifiedContext.newPage(), unifiedB = await unifiedContext.newPage()
    for (const page of [unifiedA, unifiedB]) {
      const baseline = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list', { timeout: 60000 })
      const metadata = page.waitForResponse(response => new URL(response.url()).pathname === '/account/api/workbench/catalog', { timeout: 60000 })
      await page.goto(`${primary}/?dshRuntime=${localRuntime}`)
      assert.equal((await (await baseline).json()).result.ok, true)
      assert.ok((await (await metadata).json()).personalWorkspaces.some(group => group.runtime.runtimeId === unifiedRuntime && group.items.length > 0))
      const postpone = page.getByRole('button', { name: '稍后配置', exact: true })
      try { await postpone.click({ timeout: 2000 }) } catch (error) { if (error.name !== 'TimeoutError') throw error }
      await input(page).waitFor({ state: 'visible', timeout: 30000 })
    }
    if (!await input(unifiedA).isEditable()) {
      await unifiedA.getByRole('button', { name: '选择工作区', exact: true }).click()
      await unifiedA.getByRole('menuitem').filter({ hasText: workspaceName }).filter({ hasText: 'center' }).first().click()
      await unifiedA.waitForFunction(() => { const field = document.querySelector('textarea'); return field !== null && !field.readOnly })
    }
    await input(unifiedA).fill('本机标签页的独立草稿')
    await unifiedB.getByRole('button', { name: '选择工作区', exact: true }).click()
    const remoteWorkspace = unifiedB.getByRole('menuitem').filter({ hasText: unifiedWorkspace }).filter({ hasText: 'computer-b' }).first()
    await remoteWorkspace.waitFor({ state: 'visible', timeout: 30000 })
    await verifyUnifiedPassive()
    const preparation = unifiedB.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/account/api/scope' && new URL(response.url()).searchParams.get('dshRuntime') === unifiedRuntime, { timeout: 60000 })
    const remoteBaseline = unifiedB.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace.list'
      && new URL(response.url()).searchParams.get('dshRuntime') === unifiedRuntime, { timeout: 60000 })
    await remoteWorkspace.click()
    const prepared = await preparation
    assert.equal(prepared.status(), 204); assert.equal(prepared.headers()['set-cookie'], undefined)
    assert.equal((await (await remoteBaseline).json()).result.ok, true)
    await verifyUnifiedStarted()
    await unifiedB.waitForFunction(() => { const field = document.querySelector('textarea'); return field !== null && !field.readOnly })
    await input(unifiedB).fill('远程电脑标签页的独立草稿')
    assert.equal(await input(unifiedA).inputValue(), '本机标签页的独立草稿')
    assert.equal(new URL(unifiedB.url()).searchParams.get('dshRuntime'), localRuntime)
    assert.match(await unifiedB.locator('[aria-label="工作电脑"]:visible').innerText(), /computer-b/u)
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await unifiedB.setViewportSize({ width, height: 1000 }); await unifiedB.emulateMedia({ colorScheme })
      await capture(unifiedB, `unified-personal-${width}-${colorScheme}`)
    }
    await unifiedContext.close()
    const secondaryContext = await session(secondary, secondaryCookie)
    const worker = await secondaryContext.newPage()
    await worker.goto(`${secondary}/?dshRuntime=${remoteRuntime}`)
    try { await worker.getByRole('button', { name: '稍后配置', exact: true }).click({ timeout: 2000 }) } catch (error) { if (error.name !== 'TimeoutError') throw error }
    await worker.locator('textarea').first().waitFor({ state: 'visible', timeout: 60000 })
    await worker.locator('[aria-label="工作电脑"]:visible').waitFor({ timeout: 30000 })
    assert.equal(await worker.locator('[aria-label="工作电脑"]:visible').count(), 1)
    await worker.getByRole('button', { name: '收起侧边栏', exact: true }).click()
    assert.equal(await worker.locator('[aria-label="工作电脑"]:visible').count(), 1)
    await worker.getByRole('button', { name: '打开侧边栏', exact: true }).click()
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await worker.setViewportSize({ width, height: 1000 }); await worker.emulateMedia({ colorScheme })
      await capture(worker, `secondary-${width}-${colorScheme}`)
    }
    const admin = await context.newPage()
    await admin.goto(`${primary}/admin/deployment`)
    await adminProjectBrowser({ page: admin, primary, verifyPassive: verifyAdminProjectPassive })
    await adminDetachmentBrowser({ page: admin, primary, remoteCookie, remoteRuntime })
    await admin.getByRole('checkbox', { name: '启用多电脑' }).waitFor({ timeout: 30000 })
    await admin.getByRole('heading', { name: '部署模式', exact: true }).scrollIntoViewIfNeeded()
    assert.equal(await admin.getByRole('checkbox', { name: '启用多电脑' }).count(), 1)
    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await admin.setViewportSize({ width, height: 1000 }); await admin.emulateMedia({ colorScheme })
      await admin.getByRole('heading', { name: '部署模式', exact: true }).scrollIntoViewIfNeeded()
      await capture(admin, `admin-primary-${width}-${colorScheme}`, false)
    }
    await admin.close(); await secondaryContext.close()
    return {
      afterDisable: async () => {
        for (const page of [first, second]) {
          await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('focus')))
          await page.waitForFunction(() => document.querySelector('[aria-label="工作电脑"]') === null, undefined, { timeout: 30000 })
        }
        assert.equal(await input(first).inputValue(), '第一标签页保留的草稿')
        assert.equal(await input(second).inputValue(), '第二标签页独立的草稿')
        for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
          await first.setViewportSize({ width, height: 1000 }); await first.emulateMedia({ colorScheme })
          await capture(first, `single-${width}-${colorScheme}`)
        }
      },
      close: async () => { for (const context of contexts) await context.close(); await browser.close() },
    }
  } catch (error) {
    if (screenshots !== undefined) for (const [index, context] of contexts.entries()) for (const [number, page] of context.pages().entries()) { await page.screenshot({ path: join(screenshots, `failure-${index}-${number}.png`), fullPage: true }).catch(() => {}) }
    await browser.close(); throw error
  }
}
