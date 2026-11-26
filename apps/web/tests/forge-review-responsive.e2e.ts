/** Provider-backed change requests exercise the assembled review UI without external credentials. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-remotes/session-controller'
import type { ChangeRequestRef, ChangeRequestSnapshot, ForgeCommentId, ForgeProvider, ForgeReviewData, ForgeReviewId,
  ForgeReviewRequest, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import type { Browser, Locator, Page, Request } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { captureStableAria, launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { responsiveBrowser } from './responsive-browser.ts'
import { auditResponsiveControls } from './responsive-controls.ts'
import { auditWorkflowState, compareWorkflowGolden, newWorkflowPage, workflowMatrixEnabled } from './workflow-responsive-state.ts'
import { REPO_ROOT, saveFailureShot } from './support.ts'

const run = promisify(execFile)
const sessionId = SessionId('responsive-forge-review')
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const firstCommit = 'c'.repeat(40)
const url = 'https://review.example.invalid/project/controls/pull/42'
const ref: ChangeRequestRef = { repository: { forge: 'responsive', host: 'review.example.invalid', owner: 'project', name: 'controls' }, number: 42 }
const patch = 'diff --git a/controls.ts b/controls.ts\nindex 1111111..2222222 100644\n--- a/controls.ts\n+++ b/controls.ts\n@@ -1,2 +1,3 @@\n export const title = "Shared controls"\n-export const target = 28\n+export const target = 44\n+export const description = "Keep every action reachable on a phone and a keyboard"\n'
const targetPatch = 'diff --git a/controls.ts b/controls.ts\nindex 1111111..3333333 100644\n--- a/controls.ts\n+++ b/controls.ts\n@@ -1,2 +1,2 @@\n export const title = "Shared controls"\n-export const target = 28\n+export const target = 44\n'
const descriptionPatch = 'diff --git a/controls.ts b/controls.ts\nindex 3333333..2222222 100644\n--- a/controls.ts\n+++ b/controls.ts\n@@ -1,2 +1,3 @@\n export const title = "Shared controls"\n export const target = 44\n+export const description = "Keep every action reachable on a phone and a keyboard"\n'
let scaffold: WebScaffold
let browser: Browser
let scratch: string
let snapshot: ChangeRequestSnapshot
let review: ForgeReviewData
let refuseReply = true
let refuseSubmission = true
let refuseRead = true
const actions: string[] = []
const submissions: ForgeReviewRequest[] = []
const reviewerQueries: string[] = []

async function assertTouchCardLayout(card: Locator): Promise<void> {
  const geometry = await card.evaluate((element) => {
    if (!matchMedia('(pointer: coarse)').matches) return null
    const title = element.querySelector('a')
    const toggle = element.querySelector('button[aria-expanded]')
    if (!(title instanceof HTMLElement) || !(toggle instanceof HTMLElement)) throw new Error('Missing change-request header')
    return { titleBottom: title.getBoundingClientRect().bottom, actionsTop: toggle.getBoundingClientRect().top,
      titleHeight: title.clientHeight, textHeight: title.scrollHeight }
  })
  if (geometry === null) return
  expect(geometry.actionsTop, 'Touch actions have their own row below the change-request title').toBeGreaterThanOrEqual(geometry.titleBottom)
  expect(geometry.textHeight, 'The change-request title wraps without clipping').toBeLessThanOrEqual(geometry.titleHeight + 1)
}

async function assertReviewChrome(page: Page, dialog: Locator): Promise<void> {
  await dialog.locator('[data-modal-content]').evaluate((element) => { element.scrollTop = element.scrollHeight })
  const geometry = await dialog.evaluate((element) => {
    const header = element.querySelector('[data-modal-header]')!.getBoundingClientRect()
    const content = element.querySelector('[data-modal-content]')!.getBoundingClientRect()
    const card = element.getBoundingClientRect()
    return { headerTop: header.top, headerBottom: header.bottom, cardTop: card.top,
      contentTop: content.top, contentHeight: content.height }
  })
  expect(geometry.headerTop).toBeGreaterThanOrEqual(geometry.cardTop)
  expect(geometry.headerBottom).toBeLessThanOrEqual(geometry.contentTop + 1)
  expect(geometry.contentHeight).toBeGreaterThanOrEqual(44)
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  expect(await close.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  }), 'Closing the review stays reachable after scrolling its form').toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-forge-review-'))
  const plugins = ['forge', 'forge-session', 'worktree', 'client-ui-forge']
  const overlay = join(scratch, 'review.patch.yml')
  await writeFile(overlay, '- insert:\n' + plugins.map(name => `    - id: review-${name}\n      name: '@deepseek-ai/dsh-experimental-${name}'\n`).join(''))
  scaffold = await launchWebScaffold({ workbench: true, extraOverlayPath: [overlay],
    extraInstallAnchors: plugins.map(name => join(REPO_ROOT, 'packages/experimental', name, 'package.json')) })
  await run('git', ['init', '-b', 'main'], { cwd: scaffold.workspaceCwd })
  await writeFile(join(scaffold.workspaceCwd, 'controls.ts'), 'export const title = "Shared controls"\nexport const target = 28\n')
  await run('git', ['add', 'controls.ts'], { cwd: scaffold.workspaceCwd })
  await run('git', ['-c', 'user.name=Review fixture', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Review fixture'], { cwd: scaffold.workspaceCwd })
  await run('git', ['remote', 'add', 'origin', 'https://review.example.invalid/project/controls.git'], { cwd: scaffold.workspaceCwd })
  snapshot = {
    ref, url, title: 'Keep shared controls reachable across phones, landscape and keyboard navigation', state: 'open', draft: true,
    author: 'author', headBranch: 'responsive-controls', headSha: head, baseBranch: 'main', baseSha: base, additions: 2, deletions: 1,
    mergeability: 'mergeable', mergeReady: true, mergeMethods: ['squash', 'merge'], branchUpdates: ['merge', 'rebase'],
    reviewDecision: 'changes-requested', reviewers: [{ kind: 'user', login: 'reviewer', avatarUrl: null, requested: false, codeOwner: true, verdict: 'changes-requested', reviewedSha: base }],
    reviewersTruncated: false, canRequestReviews: true,
    checks: (['failure', 'pending', 'success', 'cancelled'] as const).map((state, index) => ({ name: `Responsive check ${index + 1}`, state, url: `${url}/checks/${index}`, workflow: 'Shared-control acceptance', startedAt: '2026-01-01T00:00:00Z', completedAt: state === 'pending' ? null : '2026-01-01T00:01:00Z', rerun: null })),
    checksRollup: 'failure', checksTruncated: false, canRerunChecks: false, unresolvedThreads: 1, threadsTruncated: false,
    closingIssues: [{ repository: ref.repository, number: 7, title: 'Make every phone action reachable', state: 'open', url: 'https://review.example.invalid/project/controls/issues/7' }],
    closingIssuesTruncated: false, updatedAt: '2026-01-01T00:00:00Z', closedAt: null,
  }
  review = { headSha: head, viewer: 'reviewer', truncated: false, pendingReview: null, viewerCanReview: true, threads: [{
    id: 'responsive-thread' as ForgeThreadId, path: 'controls.ts', side: 'R', subject: 'line',
    current: { commit: head, startLine: 2, endLine: 2 }, original: { commit: head, startLine: 2, endLine: 2 },
    diffHunk: '@@ -1,2 +1,3 @@\n export const title = "Shared controls"\n-export const target = 28\n+export const target = 44',
    resolved: false, viewerCanReply: true, viewerCanResolve: true,
    comments: [{ id: 'responsive-comment' as ForgeCommentId, author: { login: 'reviewer', avatarUrl: null, bot: false },
      body: 'Please verify the target in a narrow landscape viewport before resolving this thread.', createdAt: '2026-01-01T00:00:00Z',
      pending: false, url: `${url}#discussion`, viewerCanEdit: true, viewerCanDelete: true }],
  }] }
  const provider: ForgeProvider = {
    forge: 'responsive', repositoryFromRemote: remote => remote.includes('review.example.invalid') ? ref.repository : undefined,
    changeRequestFromUrl: target => target === url ? ref : undefined, changeRequestUrl: () => url,
    fetch: async refs => new Map(refs.map(target => [changeRequestKey(target), refuseRead
      ? { code: 'unavailable' as const, message: 'Review host is temporarily unavailable.' } : snapshot])),
    findByHead: async () => [], readiness: async () => refuseRead
      ? { state: 'unavailable', message: 'Review host is temporarily unavailable.' } : { state: 'ready', message: null },
    markReady: async () => { snapshot = { ...snapshot, draft: false }; actions.push('ready') },
    merge: async (_target, request) => {
      snapshot = { ...snapshot, state: 'merged', closedAt: '2026-01-01T00:02:00Z' }
      actions.push(`merge:${request.method}:${request.headSha}`)
    },
    diff: async () => patch,
    fileText: async (_target, commit) => `export const title = "Shared controls"\nexport const target = ${commit === base ? '28' : '44'}\n${commit === head ? 'export const description = "Keep every action reachable on a phone and a keyboard"\n' : ''}`,
    fileUrl: () => `${url}/files`,
    commits: async () => ({ headSha: head, truncated: false, commits: [
      { sha: firstCommit, parent: base, title: 'Enlarge touch controls', author: 'author', authoredAt: '2026-01-01T00:00:00Z' },
      { sha: head, parent: firstCommit, title: 'Explain keyboard reachability', author: 'author', authoredAt: '2026-01-01T00:01:00Z' },
    ] }),
    compare: async (_target, from, to) => {
      actions.push(`compare:${from}:${to}`)
      return to === firstCommit ? targetPatch : from === firstCommit ? descriptionPatch : patch
    },
    readReview: async () => review,
    submitReview: async (_target, request) => {
      submissions.push(request)
      if (refuseSubmission) {
        refuseSubmission = false
        return { ok: false, code: 'failed', message: 'The review host did not accept this review. Try again.' }
      }
      return { ok: true, url: `${url}#submitted-review` }
    },
    writeReview: async (_target, write) => {
      actions.push(write.kind)
      if (write.kind === 'reply' && refuseReply) {
        refuseReply = false
        return { ok: false, code: 'failed', message: 'The review host could not save this reply. Try again.' }
      }
      if (write.kind === 'reply') review = { ...review, threads: review.threads.map(thread => thread.id !== write.thread ? thread : {
        ...thread, comments: [...thread.comments, { id: 'responsive-reply' as ForgeCommentId, author: { login: 'reviewer', avatarUrl: null, bot: false }, body: write.body, createdAt: '2026-01-01T00:02:00Z', pending: write.pending, url: `${url}#reply`, viewerCanEdit: true, viewerCanDelete: true }],
      }) }
      else if (write.kind === 'resolve') review = { ...review, threads: review.threads.map(thread => thread.id !== write.thread ? thread : { ...thread, resolved: write.resolved }) }
      else if (write.kind === 'edit-comment') review = { ...review, threads: review.threads.map(thread => ({ ...thread, comments: thread.comments.map(comment => comment.id === write.comment ? { ...comment, body: write.body } : comment) })) }
      else if (write.kind === 'delete-comment') review = { ...review, threads: review.threads.map(thread => ({ ...thread, comments: thread.comments.filter(comment => comment.id !== write.comment) })).filter(thread => thread.comments.length > 0) }
      else if (write.kind === 'add-pending') {
        const sequence = actions.filter(action => action === 'add-pending').length
        review = { ...review, pendingReview: { id: 'responsive-pending-review' as ForgeReviewId,
          comments: (review.pendingReview?.comments ?? 0) + 1 }, threads: [...review.threads, {
          id: `responsive-inline-${sequence}` as ForgeThreadId, path: write.comment.path, side: write.comment.side, subject: 'line',
          current: { commit: head, startLine: write.comment.startLine, endLine: write.comment.endLine },
          original: { commit: head, startLine: write.comment.startLine, endLine: write.comment.endLine },
          diffHunk: '@@ -1,2 +1,3 @@\n export const title = "Shared controls"\n-export const target = 28\n+export const target = 44',
          resolved: false, viewerCanReply: true, viewerCanResolve: true,
          comments: [{ id: `responsive-inline-comment-${sequence}` as ForgeCommentId,
            author: { login: 'reviewer', avatarUrl: null, bot: false }, body: write.comment.body,
            createdAt: '2026-01-01T00:02:00Z', pending: true, url: `${url}#pending-${sequence}`,
            viewerCanEdit: true, viewerCanDelete: true }],
        }] }
      } else if (write.kind === 'submit-pending') {
        actions.push(`submit-pending:${write.event}`)
        review = { ...review, pendingReview: null, threads: review.threads.map(thread => ({
          ...thread, comments: thread.comments.map(comment => ({ ...comment, pending: false })),
        })) }
      } else if (write.kind === 'discard-pending') review = { ...review, pendingReview: null,
        threads: review.threads.map(thread => ({ ...thread, comments: thread.comments.filter(comment => !comment.pending) }))
          .filter(thread => thread.comments.length > 0) }
      return { ok: true }
    },
    requestReviews: async (_target, request) => { actions.push(`request:${request.reviewers[0]?.login}`) },
    reviewerCandidates: async (_target, query) => {
      reviewerQueries.push(query)
      return [{ login: 'phone-reviewer', name: 'Phone reviewer', avatarUrl: null, suggested: true }]
    },
    updateBranch: async (_target, request) => {
      snapshot = { ...snapshot, branchUpdates: [] }
      actions.push(`update:${request.method}:${request.headSha}`)
    },
  }
  await scaffold.ctx.plugin({ inject: ['forge'], apply(ctx) { ctx.forge.register(provider) } })
  await seedSession(scaffold, await readFile(join(REPO_ROOT, 'apps/web/tests/snapshots/seeded-history/seed.jsonl'), 'utf8'), sessionId)
  const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw new Error(resolved.error.message)
  scaffold.ctx.forgeSession.track(resolved.agent.session, url)
  browser = await responsiveBrowser.launch()
}, 120_000)

afterAll(async () => {
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
  }
})

it('reviews commits, resolves threads and submits or discards reviews through the real provider', async () => {
  const page = await newWorkflowPage(browser)
  await page.clock.setFixedTime(new Date('2026-01-01T00:03:00Z'))
  const tripwire = watchConsole(page)
  const pendingRequests = new Map<Request, { path: string; status?: number; contentType?: string }>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) pendingRequests.set(request, { path })
  })
  page.on('response', (response) => {
    const request = pendingRequests.get(response.request())
    if (request !== undefined) {
      request.status = response.status()
      const contentType = response.headers()['content-type']
      if (contentType !== undefined) request.contentType = contentType
    }
  })
  page.on('requestfinished', (request) => { pendingRequests.delete(request) })
  page.on('requestfailed', (request) => { pendingRequests.delete(request) })
  await page.addInitScript((id) => { if (window === window.top) localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, sessionId)
  try {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-forge-header]').click()
    const card = page.locator(`[data-forge-change="${url}"]`)
    await card.waitFor()
    await card.getByRole('button', { name: 'Retry', exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'provider-read-failed', page.locator('[data-forge-panel]'), [], undefined, async () => { await assertTouchCardLayout(card) })
    refuseRead = false
    await card.getByRole('button', { name: 'Retry', exact: true }).click()
    await card.getByText(snapshot.title, { exact: true }).waitFor()
    await card.getByRole('button', { name: /^Collapse /u }).click()
    await auditWorkflowState(page, 'forge-review', 'collapsed-change', card, [], undefined, async () => { await assertTouchCardLayout(card) })
    await card.getByRole('button', { name: /Expand/u }).click()
    await auditWorkflowState(page, 'forge-review', 'draft-change', card, [], undefined, async () => { await assertTouchCardLayout(card) })
    await card.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await expect.poll(() => snapshot.draft, { timeout: 10_000 }).toBe(false)
    await card.getByRole('button', { name: 'Merge', exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'expanded-change', card)
    await card.locator('[data-forge-checks]').click()
    await auditWorkflowState(page, 'forge-review', 'checks-menu', page.getByRole('menu'))
    await page.getByRole('menuitem', { name: /Show 1 more/u }).click()
    await page.getByText('Responsive check 3', { exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'all-checks-menu', page.getByRole('menu'))
    await page.keyboard.press('Escape')
    await card.locator('[data-forge-review]').click()
    await auditWorkflowState(page, 'forge-review', 'reviewers-menu', page.getByRole('menu'))
    await page.getByRole('menuitem', { name: 'Request a review from someone else…', exact: true }).click()
    const search = page.getByRole('textbox', { name: 'Search people' })
    await search.fill('phone')
    await expect.poll(() => reviewerQueries, { timeout: 5_000 }).toContain('phone')
    await page.getByRole('menuitem', { name: /phone-reviewer/u }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'reviewer-search', page.getByRole('menu'), [search])
    await page.getByRole('menuitem', { name: /phone-reviewer/u }).click()
    await expect.poll(() => actions, { timeout: 10_000 }).toContain('request:phone-reviewer')
    await card.locator('[data-forge-update-branch]').click()
    await auditWorkflowState(page, 'forge-review', 'update-branch-menu', page.getByRole('menu'))
    await page.getByRole('menuitem', { name: /^Update with rebase/u }).click()
    await page.getByRole('menuitem', { name: 'Confirm update', exact: true }).click()
    await expect.poll(() => actions, { timeout: 10_000 }).toContain(`update:rebase:${head}`)
    await card.locator('[data-forge-update-branch]').waitFor({ state: 'hidden' })
    await auditWorkflowState(page, 'forge-review', 'updated-branch', card)
    await card.getByRole('button', { name: /^View.*changes/u }).click()
    const changes = page.locator('[data-forge-changes="change"]')
    const thread = page.locator('[data-forge-thread="responsive-thread"]')
    await thread.waitFor()
    await auditWorkflowState(page, 'forge-review', 'review-thread', changes, [], async () => {
      const diffWidth = await changes.locator('[data-forge-changes-scroll]').evaluate(element => element.getBoundingClientRect().width)
      await expect.poll(() => changes.locator('[data-split]').count()).toBe(diffWidth < 600 ? 0 : 1)
      const header = changes.locator('[data-forge-commits]').locator('xpath=ancestor::div[1]')
      const boxes = await header.locator('button').evaluateAll(buttons => buttons.map((button) => {
        const rect = button.getBoundingClientRect()
        return { name: button.getAttribute('aria-label') ?? button.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }))
      expect(boxes).toHaveLength(3)
      for (let index = 1; index < boxes.length; index++) {
        const before = boxes[index - 1]!
        const after = boxes[index]!
        expect(before.right <= after.left || before.bottom <= after.top, `${before.name} overlaps ${after.name}`).toBe(true)
      }
      const file = changes.locator('[data-forge-diff-file="controls.ts"]')
      for (const control of [
        file.getByRole('button', { name: 'Collapse controls.ts', exact: true }),
        file.getByRole('button', { name: 'controls.ts has 1 unresolved threads; go to the next one', exact: true }),
        file.getByRole('checkbox', { name: 'Mark controls.ts as viewed', exact: true }).locator('..'),
        file.getByRole('button', { name: 'More actions for controls.ts', exact: true }),
      ]) {
        const bounds = await control.boundingBox()
        expect(bounds?.width).toBeGreaterThanOrEqual(44)
        expect(bounds?.height).toBeGreaterThanOrEqual(44)
      }
    })
    await thread.getByRole('button', { name: 'Reply…', exact: true }).click()
    const reply = thread.getByRole('textbox', { name: 'Reply…' })
    await reply.fill('Confirmed that the phone controls stay reachable in landscape.')
    await auditWorkflowState(page, 'forge-review', 'reply-draft', changes, [reply], async () => {
      await reply.waitFor({ timeout: 5_000 })
      expect(await reply.inputValue()).toBe('Confirmed that the phone controls stay reachable in landscape.')
      expect(await reply.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    })
    await thread.getByRole('button', { name: 'Reply options', exact: true }).click()
    await auditWorkflowState(page, 'forge-review', 'reply-options', page.getByRole('menu'))
    await page.keyboard.press('Escape')
    await thread.getByRole('button', { name: 'Reply', exact: true }).click()
    await thread.getByRole('alert').waitFor()
    expect(await reply.inputValue()).toBe('Confirmed that the phone controls stay reachable in landscape.')
    expect(actions.filter(action => action === 'reply')).toHaveLength(1)
    await auditWorkflowState(page, 'forge-review', 'reply-failed', changes, [reply])
    await thread.getByRole('button', { name: 'Reply', exact: true }).click()
    await thread.getByText('Confirmed that the phone controls stay reachable in landscape.', { exact: true }).waitFor()
    const comment = thread.locator('[data-forge-thread-comment="responsive-comment"]')
    const commentActions = comment.getByRole('button', { name: 'Actions for the comment by reviewer', exact: true })
    await commentActions.click()
    await auditWorkflowState(page, 'forge-review', 'comment-actions', page.getByRole('menu'))
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    const edit = comment.getByRole('textbox', { name: 'Edit comment', exact: true })
    await edit.fill('The shared controls now remain reachable in phone landscape.')
    await auditWorkflowState(page, 'forge-review', 'comment-edit', changes, [edit], async () => {
      await edit.waitFor({ timeout: 5_000 })
      expect(await edit.inputValue()).toBe('The shared controls now remain reachable in phone landscape.')
    })
    await comment.getByRole('button', { name: 'Save', exact: true }).click()
    await comment.getByText('The shared controls now remain reachable in phone landscape.', { exact: true }).waitFor()
    await commentActions.click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await auditWorkflowState(page, 'forge-review', 'comment-delete-confirmation', changes)
    await comment.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await comment.count()).toBe(1)
    await commentActions.click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await comment.getByRole('button', { name: 'Delete', exact: true }).click()
    await comment.waitFor({ state: 'hidden' })
    await thread.getByRole('button', { name: 'Resolve thread', exact: true }).click()
    await expect.poll(() => review.threads[0]?.resolved, { timeout: 10_000 }).toBe(true)
    await auditWorkflowState(page, 'forge-review', 'resolved-thread', changes)
    expect(actions).toContain('reply')

    await changes.locator('[data-forge-threads-toggle]').click()
    const threadList = changes.locator('[data-forge-thread-list]')
    await threadList.getByRole('radio', { name: /^Unresolved/u }).click()
    await threadList.getByText('No threads match this filter', { exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'thread-filter-empty', threadList)
    await threadList.getByRole('radio', { name: /^Resolved/u }).click()
    await threadList.locator('[data-forge-thread-item="responsive-thread"]').waitFor()
    await auditWorkflowState(page, 'forge-review', 'thread-filter-resolved', threadList)
    await threadList.getByRole('button', { name: 'Close the thread list', exact: true }).click()

    const chooseLayer = async (name: 'Interface' | 'All'): Promise<void> => {
      const segment = changes.getByRole('radiogroup', { name: 'Review layer', exact: true }).getByRole('radio', { name: new RegExp(`^${name}`, 'u') })
      if (await segment.isVisible()) await segment.click()
      else {
        await changes.locator('[data-forge-lens-menu]').click()
        await page.getByRole('menuitem', { name: new RegExp(`^${name}`, 'u') }).click()
      }
    }
    await chooseLayer('Interface')
    await changes.getByText('No files to show', { exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'review-layer-empty', changes)
    await chooseLayer('All')
    await changes.locator('[data-forge-diff-file="controls.ts"]').waitFor()

    const viewed = changes.getByRole('checkbox', { name: 'Mark controls.ts as viewed', exact: true })
    await viewed.check()
    expect(await viewed.isChecked()).toBe(true)
    await auditWorkflowState(page, 'forge-review', 'file-viewed', changes, [viewed])
    await viewed.uncheck()
    await changes.getByRole('button', { name: 'All 1 files', exact: true }).click()
    const fileFilter = page.getByRole('menu').getByRole('textbox', { name: 'Filter files…', exact: true })
    await fileFilter.fill('missing')
    await page.getByRole('menu').getByText('No matching files', { exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'file-filter-empty', page.getByRole('menu'), [fileFilter])
    await fileFilter.fill('controls')
    await page.getByRole('menuitem', { name: 'controls.ts', exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'file-filter-match', page.getByRole('menu'), [fileFilter])
    await fileFilter.fill('')
    await page.getByRole('menuitem', { name: 'controls.ts', exact: true }).click()

    const commitMenu = changes.locator('[data-forge-commits]')
    await commitMenu.click()
    await page.getByRole('menuitem', { name: /Enlarge touch controls/u }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'commit-picker', page.getByRole('menu'))
    await page.getByRole('menuitem', { name: /Enlarge touch controls/u }).click()
    await expect.poll(() => commitMenu.getAttribute('data-forge-commits')).toBe(`${firstCommit}..${firstCommit}`)
    await expect.poll(() => actions, { timeout: 10_000 }).toContain(`compare:${base}:${firstCommit}`)
    await changes.getByText('export const target = 44', { exact: true }).waitFor()
    await auditWorkflowState(page, 'forge-review', 'single-commit', changes)
    await commitMenu.click()
    await page.getByRole('menuitem', { name: /Explain keyboard reachability/u }).click({ modifiers: ['Shift'] })
    await expect.poll(() => commitMenu.getAttribute('data-forge-commits')).toBe(`${firstCommit}..${head}`)
    await expect.poll(() => actions, { timeout: 10_000 }).toContain(`compare:${base}:${head}`)
    await auditWorkflowState(page, 'forge-review', 'commit-range', changes)
    await commitMenu.click()
    await page.getByRole('menuitem', { name: /^All commits/u }).click()
    await expect.poll(() => commitMenu.getAttribute('data-forge-commits')).toBe('')

    const submitReview = changes.getByRole('button', { name: /^Submit review/u })
    await submitReview.click()
    const dialog = page.getByRole('dialog', { name: 'Submit review', exact: true })
    const summary = dialog.getByRole('textbox', { name: 'Review summary…', exact: true })
    const submit = dialog.getByRole('button', { name: 'Submit review', exact: true })
    expect(await submit.isDisabled()).toBe(true)
    await dialog.getByRole('radio', { name: 'Approve', exact: true }).check()
    expect(await submit.isEnabled()).toBe(true)
    await auditWorkflowState(page, 'forge-review', 'approve-review', dialog, [], undefined, async () => { await assertReviewChrome(page, dialog) })
    await dialog.getByRole('radio', { name: 'Request changes', exact: true }).check()
    expect(await submit.isDisabled()).toBe(true)
    expect(await summary.getAttribute('required')).not.toBeNull()
    await auditWorkflowState(page, 'forge-review', 'request-changes-empty', dialog, [summary], undefined, async () => { await assertReviewChrome(page, dialog) })
    const originalViewport = page.viewportSize()
    if (originalViewport === null) throw new Error('Review acceptance requires an explicit viewport')
    try {
      await page.setViewportSize({ width: 872, height: 76 })
      await expect.poll(() => dialog.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto')
      await summary.fill('Draft retained after the shortest viewport.')
      await auditResponsiveControls(page, dialog, 'forge-review/76px-visible-area')
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    } finally { await page.setViewportSize(originalViewport) }
    await submitReview.click()
    await expect.poll(() => summary.inputValue()).toBe('Draft retained after the shortest viewport.')
    await summary.fill('Keep the complete review controls available at short landscape heights.')
    await submit.click()
    await dialog.getByRole('alert').waitFor()
    expect(submissions).toHaveLength(1)
    expect(await summary.inputValue()).toBe('Keep the complete review controls available at short landscape heights.')
    await auditWorkflowState(page, 'forge-review', 'review-submission-failed', dialog, [summary, submit], undefined, async () => { await assertReviewChrome(page, dialog) })
    await submit.click()
    await dialog.waitFor({ state: 'hidden' })
    expect(submissions).toEqual(Array.from({ length: 2 }, () => ({ kind: 'review', headSha: head,
      event: 'request-changes', body: 'Keep the complete review controls available at short landscape heights.', comments: [] })))

    const addPending = async (body: string, state: string): Promise<void> => {
      await changes.getByRole('button', { name: 'Select line R2', exact: true }).click()
      await auditWorkflowState(page, 'forge-review', `${state}-selected-line`, changes)
      await changes.getByRole('button', { name: 'Add comment', exact: true }).click()
      const composer = changes.locator('[data-forge-comment="R2-2"]')
      await composer.getByRole('textbox', { name: 'Leave a comment…', exact: true }).fill(body)
      await auditWorkflowState(page, 'forge-review', state, composer)
      await composer.getByRole('button', { name: 'Start review', exact: true }).click()
      await composer.waitFor({ state: 'hidden' })
      await expect.poll(() => review.pendingReview?.comments, { timeout: 10_000 }).toBe(1)
    }
    await addPending('The forty-four-pixel action remains reachable on touch screens.', 'inline-review-draft')
    await submitReview.click()
    await dialog.getByText('Pending comments (1)', { exact: true }).waitFor()
    await dialog.getByRole('radio', { name: 'Approve', exact: true }).check()
    await auditWorkflowState(page, 'forge-review', 'pending-review-submit', dialog, [submit])
    await submit.click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => actions, { timeout: 10_000 }).toContain('submit-pending:approve')
    expect(review.pendingReview).toBeNull()
    expect(review.threads.find(item => item.id === 'responsive-inline-1')?.comments[0]?.pending).toBe(false)

    await addPending('This draft is discarded after checking the confirmation controls.', 'inline-discard-draft')
    await submitReview.click()
    await dialog.getByRole('button', { name: 'Discard review', exact: true }).click()
    const discard = dialog.getByRole('group', { name: 'Discard review', exact: true })
    await auditWorkflowState(page, 'forge-review', 'pending-review-discard', dialog)
    await discard.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(review.pendingReview?.comments).toBe(1)
    await dialog.getByRole('button', { name: 'Discard review', exact: true }).click()
    await discard.getByRole('button', { name: 'Discard review', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => review.pendingReview, { timeout: 10_000 }).toBeNull()
    expect(review.threads.some(item => item.id === 'responsive-inline-2')).toBe(false)
    expect(review.threads.some(item => item.id === 'responsive-inline-1')).toBe(true)
    await compareWorkflowGolden(join(REPO_ROOT, 'apps/web/tests/expected/forge-review/ui.expected.md'),
      await captureStableAria(page, '[data-forge-changes]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('tab', { name: /^Change requests/u }).click()
    await card.getByRole('button', { name: 'Merge', exact: true }).click()
    await auditWorkflowState(page, 'forge-review', 'merge-confirmation', page.getByRole('menu'))
    await page.keyboard.press('Escape')
    expect(snapshot.state).toBe('open')
    await card.getByRole('button', { name: 'Merge', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Confirm merge', exact: true }).click()
    await expect.poll(() => actions, { timeout: 10_000 }).toContain(`merge:squash:${head}`)
    await card.getByText(/Merged into main/u).waitFor()
    await auditWorkflowState(page, 'forge-review', 'merged-change', card)
    await expect.poll(() => [...pendingRequests.values()].filter(request =>
      request.path === '/api/_stream/forgePanel/changeRequestStates').length, { timeout: 5_000 }).toBeLessThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    await saveFailureShot(page, 'forge-review-responsive')
    console.error('Forge fixture provider calls', { actions, reviewerQueries, pageErrors: tripwire.pageErrors,
      pendingRequests: [...pendingRequests.values()] })
    throw error
  } finally { await page.close() }
}, workflowMatrixEnabled ? 900_000 : 90_000)
