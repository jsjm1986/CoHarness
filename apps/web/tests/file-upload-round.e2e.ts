// Web e2e scenario: file upload round trip through the userdoc stack. A real
// chromium picks a file through the composer file input; the resumable
// document upload stores the exact bytes below the scaffold's isolated
// DSH_HOME, the document rail reports the staged upload, the prompt admits
// the document as rendered text plus `source.documents` metadata, and the
// model (replayed or live) reads the saved copy with the REAL read tool.
// The content-addressed store makes the saved path identical across record
// and replay once the workspace cwd is tokenized, so the recorded read
// arguments replay verbatim against a freshly re-uploaded object.
// Record: DSH_SNAPSHOT=record rewrites session.v7.jsonl, then a keyless
// DSH_SNAPSHOT=refresh regenerates ui.expected.md.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'
import type { AriaPathDecl } from './aria-normalize.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/file-upload-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/session.v7.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/ui.expected.md', import.meta.url))
const TRAJECTORY_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/trajectory.expected.md', import.meta.url))
const TRAJECTORY_STATUS_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/trajectory-status.expected.md', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('../../../snapshots/web/file-upload-round/replay.override.json', import.meta.url))
const DRAFT_EXPECTED = fileURLToPath(new URL('./expected/file-upload-round/draft.expected.md', import.meta.url))
const HISTORY_EXPECTED = fileURLToPath(new URL('./expected/file-upload-round/history.expected.md', import.meta.url))
const IMAGE_FIXTURE = fileURLToPath(new URL('../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
const MODE = webSnapshotMode()

/** The uploaded fixture file: constant bytes so record and replay share one content digest. */
const FILE_NAME = 'poem.txt'
const FILE_TEXT = 'UPLOAD_ROUND_OK\n'
const PROMPT = 'Read the attached file with the read tool, reply with exactly the single word it contains, and stop.'
const IMAGE_NAMES = Array.from({ length: 10 }, (_unused, index) => `reference-${String(index + 1)}.png`)

/** Browser-measured relations for the composer's split draft rails. */
interface DraftRailsGeometry {
  readonly documentReady: boolean
  readonly documentTitle: string | null
  readonly imageCount: number
  readonly imageOrder: readonly string[]
  readonly oneImageRow: boolean
  readonly imageOverflow: boolean
  readonly imageNoWrap: boolean
}

/** Render stable relations instead of platform-dependent absolute coordinates. */
function renderDraftRailsGeometry(geometry: DraftRailsGeometry): string {
  return [
    '# Composer draft rails',
    '',
    `- the document item settled ready: ${String(geometry.documentReady)}`,
    `- the document item title: ${String(geometry.documentTitle)}`,
    `- image thumbnails: ${String(geometry.imageCount)}`,
    `- image order: ${geometry.imageOrder.join(' > ')}`,
    `- all thumbnails share one row: ${String(geometry.oneImageRow)}`,
    `- overflowing thumbnails scroll horizontally: ${String(geometry.imageOverflow)}`,
    `- the rail does not wrap: ${String(geometry.imageNoWrap)}`,
  ].join('\n')
}

describe('web e2e: file upload through the real assembly', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  let liveTrajectory: string | undefined

  /** Declared temporary paths every captured snapshot tokenizes. */
  const ariaPaths = (): readonly AriaPathDecl[] => [
    { path: scaffold.documentRoot, token: '{{documents}}' },
    // The hierarchy crumb truncates the title mid-path (`at \"/var/fo…` keeps
    // only the run-local root's head), so the literal path cannot match it.
    { pattern: / at \\"\/[^\\"'\s]*/g, token: ' at \\"{{documents}}' },
  ]

  /**
   * The live USER row names the document's inlined text (the path is the
   * run-local upload root), so selectors match the stable prefix only.
   */
  const userRow = () => page.getByRole('row', {
    name: /^USER, Uploaded document "poem\.txt" at "[^"]*"; contents inlined verbatim:/,
  })

  /** Inspect one durable mixed message through the real image slot and all message tabs. */
  async function inspectTrajectoryAttachments(): Promise<string> {
    const userMessage = sessionEvents.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (userMessage?.type !== 'user/message') throw new Error('the replayed turn recorded no user message')
    const content = userMessage.data.content
    const imageName = IMAGE_NAMES[0]!
    await page.getByRole('tab', { name: 'Chat', exact: true }).click()
    const chatImage = page.getByRole('img', { name: imageName, exact: true })
    await expect.poll(() => chatImage.getAttribute('src'), { timeout: 10_000 }).toMatch(/^blob:/)
    const chatImageUrl = await chatImage.getAttribute('src')

    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
    const row = userRow()
    await row.waitFor({ timeout: 10_000 })
    const ledger = await captureStableAria(
      page, '[data-trajectory-row-key][aria-label*="Uploaded document"]', scaffold.workspaceCwd, ariaPaths(),
    )
    await row.click()

    const panel = page.getByRole('tabpanel')
    // Durable images render through the shared image-gallery slot —
    // tile/single buttons inside a plain container; documents reach the log as
    // inlined text blocks, so the panel carries the document text instead of
    // an attachment row.
    const gallery = panel.locator('[class*="messageImages"]')
    let summaryAttachments: string | undefined
    let preview: string | undefined
    for (const tab of ['Summary', 'Preview']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      const opener = gallery.getByRole('button', { name: `${imageName}, click to view original`, exact: true })
      await opener.waitFor()
      const thumbnail = gallery.getByRole('img', { name: imageName, exact: true })
      await expect.poll(() => thumbnail.getAttribute('src'), { timeout: 10_000 }).toBe(chatImageUrl)
      expect(await thumbnail.evaluate(element => getComputedStyle(element).objectFit)).toBe('cover')

      const attachments = await captureStableAria(
        page, '[role="tabpanel"] [class*="messageImages"]', scaffold.workspaceCwd, ariaPaths(),
      )
      if (tab === 'Summary') summaryAttachments = attachments
      else {
        expect(attachments).toBe(summaryAttachments)
        preview = await captureStableAria(page, '[role="tabpanel"]', scaffold.workspaceCwd, ariaPaths())
      }
      await opener.focus()
      await opener.press('Enter')
      const dialog = page.getByRole('dialog', { name: 'Original image preview', exact: true })
      await dialog.waitFor()
      expect(await dialog.getByRole('img', { name: imageName }).getAttribute('src')).toBe(chatImageUrl)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      expect(await opener.evaluate(element => element === document.activeElement)).toBe(true)
    }

    await page.getByRole('tab', { name: 'Raw', exact: true }).click()
    // The Raw tab renders each source block as a section: text blocks
    // verbatim in <pre>, image blocks inline through the image slot.
    const blocks = panel.locator('[class*="sourceBlocks"] section')
    expect(await blocks.count()).toBe(content.length)
    for (const [index, block] of content.entries()) {
      const renderedBlock = blocks.nth(index)
      if (block.type === 'text') {
        expect(await renderedBlock.locator('pre').textContent()).toBe(block.text)
      } else {
        expect(block.type).toBe('image')
        await renderedBlock.getByRole('img', { name: imageName, exact: true }).waitFor()
      }
    }
    const raw = await captureStableAria(page, '[role="tabpanel"]', scaffold.workspaceCwd, ariaPaths())
    return [
      '# Ledger', ledger,
      '# Summary attachments', summaryAttachments,
      '# Preview', preview,
      '# Raw', raw,
    ].join('\n\n')
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      // The override rescripts the recorded read arguments with a
      // `{{fromRequest:…}}` placeholder: the saved-copy path differs per run,
      // and the live handle line in the request carries the current one.
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, replayOverride: OVERRIDE, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 900, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('uploads on pick, gates send on the staged document, and settles the turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-drive'))
    if (MODE !== 'record') {
      // Drift guard: the committed fixture must carry exactly the drive prompt.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const modelTrigger = page.getByRole('button', { name: /^Select model, current/ })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /^Model\b/ }).click()
    await page.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash-Vision-Exp' }).click()
    await expect.poll(() => modelTrigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toContain('DeepSeek-V4-Flash-Vision-Exp')
    const imageBytes = await readFile(IMAGE_FIXTURE)
    // Pick through the composer's hidden file input: the document upload and
    // image intake both run before any prompt is typed.
    await page.locator('input[type="file"]').setInputFiles([
      { name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(FILE_TEXT) },
      ...IMAGE_NAMES.map(name => ({ name, mimeType: 'image/png', buffer: imageBytes })),
    ])
    const documentRail = page.getByRole('list', { name: 'Pending documents', exact: true })
    const imageRail = page.getByRole('group', { name: 'Pending images', exact: true })
    const documentItem = documentRail.getByRole('listitem')
    await documentItem.waitFor({ timeout: 10_000 })
    await expect.poll(() => documentItem.getAttribute('data-document-status'), { timeout: 15_000 }).toBe('ready')
    await expect.poll(() => imageRail.locator('img').count(), { timeout: 10_000 }).toBe(IMAGE_NAMES.length)
    const geometry: DraftRailsGeometry = await imageRail.evaluate((element): DraftRailsGeometry => {
      const items = [...element.querySelectorAll('img')] as HTMLElement[]
      const boxes = items.map(item => item.getBoundingClientRect())
      const fileItem = document.querySelector('[role="list"][aria-label="Pending documents"] [role="listitem"]')
      return {
        documentReady: fileItem?.getAttribute('data-document-status') === 'ready',
        documentTitle: fileItem?.getAttribute('title') ?? null,
        imageCount: items.length,
        imageOrder: items.map(item => item.getAttribute('alt') ?? ''),
        oneImageRow: boxes.every(box => Math.abs(box.top - (boxes[0]?.top ?? box.top)) < 0.5),
        imageOverflow: element.scrollWidth > element.clientWidth,
        imageNoWrap: getComputedStyle(element).flexWrap === 'nowrap',
      }
    })
    await compareOrRefreshGolden(DRAFT_EXPECTED, renderDraftRailsGeometry(geometry), MODE)
    for (const name of IMAGE_NAMES.slice(1)) {
      await page.getByRole('button', { name: `Remove image ${name}` }).click({ force: true })
    }
    await expect.poll(() => imageRail.locator('img').count(), { timeout: 10_000 }).toBe(1)
    await input.fill(PROMPT)
    // Send unlocks only after the document upload reports ready.
    const send = page.getByRole('button', { name: 'Send message' })
    await send.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => send.isEnabled(), { timeout: 15_000 }).toBe(true)
    const settled = scaffold.whenTurnSettled(60_000)
    await send.click()
    const sessionId = await settled
    // Each rail clears when the Host admission resolves: images at the
    // optimistic echo's retirement, the document rail at `prompt` return —
    // both strictly precede the turn barrier, so a short poll suffices here.
    try {
      await expect.poll(
        async () => await imageRail.locator('img').count() + await documentRail.locator('[role="listitem"]').count(),
        { timeout: 30_000 },
      ).toBe(0)
    } catch (error) {
      const feedback = await page.locator('[role="alert"], [role="status"]').allTextContents()
      const rail = {
        images: await imageRail.locator('img').count(),
        documents: await documentRail.locator('[role="listitem"]').count(),
        documentStatuses: await documentRail.locator('[role="listitem"]').evaluateAll(
          items => items.map(item => `${item.getAttribute('data-document-status')}:${item.getAttribute('title')}`),
        ),
      }
      throw new Error(
        `submission retained draft cards; rail=${JSON.stringify(rail)}; feedback=${JSON.stringify(feedback)}; events=${sessionEvents.map(event => event.type).join(',')}`,
        { cause: error },
      )
    }
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('persists the document and reads the stored copy with the real read tool', () => {
    const userMessage = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'user/message' }> =>
        event.type === 'user/message' && event.data.source.kind === 'user',
    )
    if (userMessage === undefined) throw new Error('the replayed turn recorded no user message')
    // The userdoc path admits documents as rendered text blocks; the durable
    // relation lives on the message source and the userdoc/attached event.
    const source = userMessage.data.source as { documents?: readonly { ref: { name: string; bytes: number } }[] }
    expect(source.documents?.length).toBe(1)
    expect(source.documents?.[0]?.ref.name).toBe(FILE_NAME)
    expect(source.documents?.[0]?.ref.bytes).toBe(Buffer.byteLength(FILE_TEXT))
    const attached = sessionEvents.find(event => event.type === 'userdoc/attached')
    expect(attached).toBeDefined()
    const documentText = userMessage.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(documentText).toContain(`Uploaded document "${FILE_NAME}" at "`)

    const readCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'read',
    )
    if (readCall === undefined) throw new Error('the replayed turn did not call the read tool')
    expect(readCall.data.arguments).toContain(FILE_NAME)
    const readResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === readCall.data.callId,
    )
    if (readResult === undefined) throw new Error('the read call produced no durable result')
    const message = readResult.data.message
    expect(message.isError).toBe(false)
    expect(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('UPLOAD_ROUND_OK')

    const turnEnds = sessionEvents.filter(event => event.type === 'turn/end')
    expect(turnEnds.length).toBe(1)
    expect((turnEnds[0] as SessionEvent & { data: { reason: { kind: string } } }).data.reason.kind).toBe('completed')
  })

  it.skipIf(MODE === 'record')('renders the uploaded document and image beside the settled answer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-aria'))
    await expect.poll(() => page.getByText('UPLOAD_ROUND_OK', { exact: false }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd, ariaPaths())
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('keeps the mixed durable message readable through the document chip and bubble', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-history'))
    const image = page.getByRole('img', { name: IMAGE_NAMES[0]!, exact: true })
    await image.waitFor({ timeout: 10_000 })
    // The userdoc path persists the document as a session-hierarchy chip plus
    // an inlined text block in the bubble; there is no extra-block disclosure.
    const chip = page.getByRole('button', { name: /^Uploaded document "poem\.txt" at "\// })
    await chip.waitFor({ timeout: 10_000 })
    await expect.poll(() => page.getByText(/Uploaded document "poem\.txt" at "\//).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1)
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd, ariaPaths())
    await compareOrRefreshGolden(HISTORY_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('shows both attachment kinds throughout the Trajectory inspector', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-trajectory'))
    liveTrajectory = await inspectTrajectoryAttachments()
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, liveTrajectory, MODE)
  })

  it.skipIf(MODE === 'record')('restores the same Trajectory attachments from persisted history after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-file-upload-trajectory-reload'))
    expect(liveTrajectory).toBeDefined()
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await inspectTrajectoryAttachments()).toBe(liveTrajectory)
  })

  it.skipIf(MODE === 'record')('keeps thumbnail loading and retry feedback inside the attachment row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-thumbnail-status'))
    const releaseRead = Promise.withResolvers<undefined>()
    const read = vi.spyOn(scaffold.ctx.attachments, 'readImage').mockImplementationOnce(async () => {
      await releaseRead.promise
      throw new Error('fixture image read failed')
    })
    try {
      // Reload clears the browser image cache so the real image slot observes the delayed read.
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      await userRow().click()
      await page.getByRole('tab', { name: 'Preview', exact: true }).click()
      const panel = page.getByRole('tabpanel')
      const gallery = panel.locator('[class*="messageImages"]:visible')
      const thumbnail = gallery.locator('[data-variant]')
      await thumbnail.waitFor()
      await thumbnail.scrollIntoViewIfNeeded()
      await expect.poll(() => read.mock.calls.length).toBe(1)
      // The 1×1 tile keeps a small frame; loading/retry feedback may overflow
      // the frame itself but must stay inside the gallery row's own box.
      const feedbackFits = async () => {
        const [box, galleryBox] = await Promise.all([thumbnail.boundingBox(), gallery.boundingBox()])
        return box !== null && galleryBox !== null
          && box.y + box.height <= galleryBox.y + galleryBox.height + 0.5
          && box.x + box.width <= galleryBox.x + galleryBox.width + 0.5
      }
      expect(await feedbackFits()).toBe(true)
      const loading = await captureStableAria(
        page, '[role="tabpanel"] [class*="messageImages"]', scaffold.workspaceCwd, ariaPaths(),
      )

      releaseRead.resolve(undefined)
      const retry = panel.getByRole('button', { name: 'Image failed to load; click to retry', exact: true })
      await retry.waitFor()
      expect(await feedbackFits()).toBe(true)
      const failed = await captureStableAria(
        page, '[role="tabpanel"] [class*="messageImages"]', scaffold.workspaceCwd, ariaPaths(),
      )
      await retry.focus()
      await retry.press('Enter')
      await panel.getByRole('img', { name: IMAGE_NAMES[0]!, exact: true }).waitFor()
      expect(read).toHaveBeenCalledTimes(2)
      await compareOrRefreshGolden(TRAJECTORY_STATUS_EXPECTED, [
        '# Loading', loading, '# Failed', failed,
      ].join('\n\n'), MODE)
    } finally {
      releaseRead.resolve(undefined)
      read.mockRestore()
    }
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl', 'replay.override.json', 'ui.expected.md', 'trajectory.expected.md', 'trajectory-status.expected.md',
    ])
  })
})
