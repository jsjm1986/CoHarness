/** Built Admin removal confirmations against isolated organization and review responses. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { nodeAccessEntrySchema, type NodeRemovalBlocker } from '../../../gateway/src/node-access.ts'
import { activateAdminControl, adminAndroidEndpoint, connectAdminAndroid, screenshotAdminPage } from './admin-android-browser.ts'
import { startAdminResponsiveFixture } from './admin-responsive-fixture.ts'
import { auditAdminTouchTargets } from './admin-responsive-state.ts'
import { compareOrRefreshGolden, webSnapshotMode } from './expected.ts'

const detached = nodeAccessEntrySchema.parse({
  nodeId: '42000000-0000-4000-8000-000000000001', name: '111', revision: 3, status: 'detached',
  platform: null, architecture: null, lastSeenAt: null, leaseExpiresAt: null, executionReady: false,
})
const bound = { ...detached, nodeId: '42000000-0000-4000-8000-000000000002', name: '绑定电脑', status: 'connected' }
const blockers: NodeRemovalBlocker[] = [
  'node-access/removal-in-use', 'node-access/removal-projects', 'node-access/removal-runtimes', 'node-access/removal-backups',
]
const widths = [[320, 568], [390, 844], [667, 375], [844, 390], [872, 230], [1280, 800]] as const
const golden = fileURLToPath(new URL('./snapshots/admin-computer-removal/blocked.expected.md', import.meta.url))

async function review(page: Page, base: string, takeGolden: boolean, label: string): Promise<void> {
  let exists = true, laterBinding = false
  let posts = 0
  await page.route(/\/admin\/api\/deployment\/nodes\/access(?:\/[^/]+\/removal)?(?:\?.*)?$/u, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!path.endsWith('/removal')) {
      const items = exists ? [detached, bound] : [bound]
      await route.fulfill({ json: { items, nextCursor: null } })
      return
    }
    const node = path.includes(bound.nodeId) ? bound : detached
    if (request.method() === 'GET') {
      await route.fulfill({ json: { nodeId: node.nodeId, revision: node.revision, blockers: node === bound ? blockers : [] } })
      return
    }
    posts += 1
    expect(node).toBe(detached)
    expect(request.postDataJSON()).toEqual({ revision: detached.revision })
    if (laterBinding) {
      await route.fulfill({ status: 409, json: { error: 'node-access/removal-backups' } })
      return
    }
    exists = false
    await route.fulfill({ json: { nodeId: node.nodeId, revision: node.revision + 1, status: 'removed', topologyRevision: '8' } })
  })
  const response = await page.request.post(`${base}/login`, {
    form: { username: 'admin', password: 'fixture-password' }, headers: { origin: base }, maxRedirects: 0,
  })
  expect(response.status()).toBe(302)
  await page.goto(`${base}/admin/deployment`)
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(viewport.width).toBeGreaterThan(0)
  if (adminAndroidEndpoint !== undefined && process.env.DSH_ADMIN_REMOVAL_ORIENTATION !== undefined) {
    expect(viewport.width > viewport.height ? 'landscape' : 'portrait').toBe(process.env.DSH_ADMIN_REMOVAL_ORIENTATION)
  }
  const area = page.getByRole('region', { name: '组织电脑连接状态', exact: true })
  const open = async (name: string) => {
    await activateAdminControl(area.getByRole('button', { name: `移除电脑 ${name}`, exact: true }))
    const dialog = page.getByRole('dialog', { name: `移除电脑 ${name}`, exact: true })
    await dialog.waitFor()
    return dialog
  }
  const blocked = await open(bound.name)
  await blocked.getByText('这台电脑暂不能移除').waitFor()
  expect(await blocked.getByRole('listitem').count()).toBe(blockers.length)
  expect(await blocked.getByRole('button', { name: '确认移除' }).isDisabled()).toBe(true)
  expect(posts).toBe(0)
  if (takeGolden) await compareOrRefreshGolden(golden, await blocked.ariaSnapshot(), webSnapshotMode())
  await auditAdminTouchTargets(page, blocked)
  const evidence = process.env.DSH_ADMIN_REMOVAL_EVIDENCE
  if (evidence !== undefined && (takeGolden || adminAndroidEndpoint !== undefined)) {
    await mkdir(evidence, { recursive: true })
    await screenshotAdminPage(page, join(evidence, `removal-${label}-blocked.png`))
  }
  const lastReason = blocked.getByRole('listitem').last()
  await lastReason.scrollIntoViewIfNeeded()
  expect(await lastReason.evaluate((element) => {
    const reason = element.getBoundingClientRect()
    const body = element.closest('.dialogBody')!.getBoundingClientRect()
    return Math.min(reason.bottom, body.bottom, innerHeight) > Math.max(reason.top, body.top, 0)
  })).toBe(true)
  await activateAdminControl(blocked.getByRole('button', { name: '取消', exact: true }))

  const eligible = await open(detached.name)
  await eligible.getByText('未发现项目、Runtime、备份或其他组织关联。', { exact: true }).waitFor()
  expect(posts).toBe(0)
  await auditAdminTouchTargets(page, eligible)
  const box = await eligible.boundingBox()
  expect(box?.x).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? viewport.width) + (box?.width ?? 1)).toBeLessThanOrEqual(viewport.width + 1)
  if (evidence !== undefined && (takeGolden || adminAndroidEndpoint !== undefined)) {
    await screenshotAdminPage(page, join(evidence, `removal-${label}-ready.png`))
  }
  if (adminAndroidEndpoint === undefined) await page.keyboard.press('Escape')
  else await activateAdminControl(eligible.getByRole('button', { name: '取消', exact: true }))
  await eligible.waitFor({ state: 'hidden' })
  expect(posts).toBe(0)

  laterBinding = true
  const changed = await open(detached.name)
  await expect.poll(() => changed.getByRole('button', { name: '确认移除' }).isEnabled()).toBe(true)
  await activateAdminControl(changed.getByRole('button', { name: '确认移除' }))
  await changed.getByRole('alert').getByText(/电脑仍关联备份/).waitFor()
  expect(await changed.getByRole('button', { name: '确认移除' }).isDisabled()).toBe(true)
  expect(posts).toBe(1)
  await activateAdminControl(changed.getByRole('button', { name: '取消', exact: true }))

  laterBinding = false
  const confirm = await open(detached.name)
  await expect.poll(() => confirm.getByRole('button', { name: '确认移除' }).isEnabled()).toBe(true)
  await activateAdminControl(confirm.getByRole('button', { name: '确认移除' }))
  await page.getByRole('status').getByText('已从组织移除 111', { exact: true }).waitFor()
  await area.getByRole('rowheader', { name: '111', exact: true }).waitFor({ state: 'hidden' })
  await area.getByRole('rowheader', { name: bound.name, exact: true }).waitFor()
  expect(posts).toBe(2)
}

it('reviews an exact computer before removal and keeps blocked or cancelled computers in the directory', async () => {
  const fixture = await startAdminResponsiveFixture(adminAndroidEndpoint === undefined ? '127.0.0.1' : 'localhost')
  onTestFinished(() => fixture.close())
  fixture.state.scope = 'organization'
  const android = adminAndroidEndpoint === undefined ? undefined : await connectAdminAndroid(fixture.base)
  const browser = android?.browser ?? await chromium.launch()
  onTestFinished(() => android === undefined ? browser.close() : android.close())
  const sizes = android === undefined ? widths : [[0, 0]] as const
  for (const [width, height] of sizes) {
    const context: BrowserContext | undefined = android === undefined
      ? await browser.newContext({ locale: 'zh-CN', viewport: { width, height }, hasTouch: width < 1024, isMobile: width < 1024 })
      : browser.contexts()[0]
    if (context === undefined) throw new Error('Device browser did not expose its active context')
    try {
      const page = await context.newPage()
      try {
        if (android !== undefined) await page.bringToFront()
        await review(page, fixture.base, width === 1280, android === undefined ? `${width}x${height}`
          : process.env.DSH_ADMIN_REMOVAL_ORIENTATION ?? 'android')
      } finally { await page.close() }
    } finally {
      if (android === undefined) await context.close()
    }
  }
})
