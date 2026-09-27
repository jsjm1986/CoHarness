/** Two real Web runtimes with colliding durable IDs behind a bounded test router. */
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, fixtureUserPrompts, watchConsole,
  captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const REPLY = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const SNAPSHOT = fileURLToPath(new URL('./snapshots/runtime-identity/panes.expected.md', import.meta.url))
const NOT_LOADED = fileURLToPath(new URL('./snapshots/runtime-identity/not-loaded.expected.md', import.meta.url))
const LEGACY_PENDING = fileURLToPath(new URL('./snapshots/runtime-identity/legacy-pending.expected.md', import.meta.url))

it.skipIf(webSnapshotMode() === 'record').each(['personal', 'project'] as const)(
  'keeps identical Session IDs independent through histories, uploads and restoration from a %s bootstrap', async (bootstrap) => {
    const runtimes: WebScaffold[] = []
    const sockets = new Set<Socket>()
    const requests = new Set<ReturnType<typeof request>>()
    const browser = await chromium.launch()
    let server: ReturnType<typeof createServer> | undefined
    let heldList: { baseUrl: string; arrived: () => void; release: Promise<undefined> } | undefined
    let releaseList: (() => void) | undefined
    let personalComplete = true
    try {
      const seed = await readFile(SEED, 'utf8')
      const id = SessionId('same-durable-session')
      const titles = ['Personal collision', 'Project collision']
      for (let index = 0; index < titles.length; index++) {
        const runtime = await launchWebScaffold({ workbench: true, openInApp: false, replayFixture: REPLY, paceMs: 5 })
        runtimes.push(runtime)
        await seedSession(runtime, seed, id)
      }
      const personal = runtimes[0]!, project = runtimes[1]!
      const selected = (url: string | undefined): string => {
        const target = new URL(url ?? '/', 'http://fixture').searchParams.get('dshTarget')
        return target === 'project:7' || (target === null && bootstrap === 'project') ? project.baseUrl : personal.baseUrl
      }
      server = createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://fixture').pathname
        if (pathname === '/account/api/context' || pathname === '/account/api/workbench/catalog') {
          const scope = bootstrap === 'personal' ? { kind: 'personal' }
            : { kind: 'project', projectId: 7, projectName: 'Project realm', mode: 'rw' }
          const context = { user: { id: 1, username: 'fixture', displayName: 'Fixture', role: 'admin' }, scope,
            projects: [{ projectId: 7, name: 'Project realm', mode: 'rw' }] }
          const catalog = { personalComplete, personal: { id: 1, name: 'Personal realm' }, activeRuntime: scope, projects: context.projects,
            items: titles.map((title, index) => ({ sessionId: id, title,
              runtime: index === 0 ? { kind: 'personal' } : { kind: 'project', projectId: 7, projectName: 'Project realm' },
              visibility: index === 0 ? 'personal' : 'project', creatorUserId: 1, creatorDisplayName: 'Fixture', updatedAt: 1, blank: false, canWrite: true }))
              .filter(item => personalComplete || item.runtime.kind === 'project') }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(pathname.endsWith('context') ? context : catalog)); return
        }
        if (pathname.startsWith('/account/')) { res.writeHead(501, { 'content-type': 'application/json' }); res.end('{"error":"fixture-endpoint-unavailable"}'); return }
        const headers = pathname === '/api/host.describe' ? { ...req.headers, 'accept-encoding': 'identity' } : req.headers
        const upstream = request(new URL(req.url ?? '/', selected(req.url)), { method: req.method, headers }, (response) => {
          if (pathname === '/api/host.describe') {
          // Independent Hosts supply real APIs; the router owns their fixed browser runtime aliases, not Gateway authorization.
            response.setEncoding('utf8')
            let body = ''
            response.on('data', (chunk: string) => { body += chunk })
            response.on('end', () => {
              const reply = JSON.parse(body) as { result: { ok: boolean; value?: { runtimeTarget?: unknown } } }
              if (reply.result.ok && reply.result.value !== undefined) {
                reply.result.value.runtimeTarget = selected(req.url) === project.baseUrl
                  ? { kind: 'project', projectId: 7 } : { kind: 'personal' }
              }
              res.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' })
              res.end(JSON.stringify(reply))
            })
            return
          }
          res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
        })
        requests.add(upstream)
        upstream.on('close', () => { requests.delete(upstream) })
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        if (pathname === '/api/session.list' && heldList?.baseUrl === selected(req.url)) {
          heldList.arrived()
          void heldList.release.then(() => { req.pipe(upstream) })
        } else req.pipe(upstream)
      })
      server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
      server.on('upgrade', (req, socket, head) => {
        const upstream = request(new URL(req.url ?? '/', selected(req.url)), { headers: req.headers })
        requests.add(upstream)
        upstream.on('close', () => { requests.delete(upstream) })
        upstream.on('error', () => { socket.destroy() })
        upstream.on('upgrade', (response, peer, peerHead) => {
          sockets.add(peer); peer.on('close', () => { sockets.delete(peer) })
          socket.write(`HTTP/1.1 ${String(response.statusCode)} ${response.statusMessage ?? 'Switching Protocols'}\r\n${response.rawHeaders.reduce<string[]>((lines, value, index, headers) => index % 2 === 0 ? [...lines, `${value}: ${headers[index + 1] ?? ''}`] : lines, []).join('\r\n')}\r\n\r\n`)
          if (head.length) peer.write(head)
          if (peerHead.length) socket.write(peerHead)
          socket.pipe(peer).pipe(socket)
          socket.on('close', () => { peer.destroy() }); peer.on('close', () => { socket.destroy() })
        })
        upstream.end()
      })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
      const tripwire = watchConsole(page)
      const listed = async (target: string): Promise<void> => {
        const response = await page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname === '/api/session.list' && url.searchParams.get('dshTarget') === target
        })
        expect(response.status()).toBe(200)
        await response.finished()
      }
      await page.goto(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, { waitUntil: 'load' })
      const toolbar = page.locator('[data-workbench-toolbar]')
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await page.getByRole('menuitem', { name: /我的工作台/ }).click()
      for (const title of titles) {
        await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Add conversation', exact: true })
        await picker.getByRole('button').filter({ hasText: title }).click()
        await picker.waitFor({ state: 'hidden' })
      }
      const keys = await page.locator('[data-session-pane]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')!))
      expect(new Set(keys).size).toBe(2)
      const [personalKey, projectKey] = keys
      const first = page.locator(`[data-session-pane="${personalKey}"]`)
      const second = page.locator(`[data-session-pane="${projectKey}"]`)
      await first.locator('textarea').fill('Personal draft')
      await second.locator('textarea').fill('Project draft')
      expect(await first.locator('textarea').inputValue()).toBe('Personal draft')
      expect(await second.locator('textarea').inputValue()).toBe('Project draft')
      const prompt = fixtureUserPrompts(await readFile(REPLY, 'utf8'))[0]!
      const settlements = runtimes.map(runtime => runtime.whenTurnSettled())
      await first.locator('textarea').fill(prompt); await first.locator('textarea').press('Enter')
      await second.locator('textarea').fill(prompt); await second.locator('textarea').press('Enter')
      expect(await Promise.all(settlements)).toEqual([id, id])
      for (const [index, pane] of [first, second].entries()) {
        await expect.poll(() => pane.locator('textarea').isEditable()).toBe(true)
        await pane.locator('input[type="file"]').setInputFiles({
          name: 'same-file.txt', mimeType: 'text/plain', buffer: Buffer.from(`runtime ${index}`),
        })
        await pane.getByRole('button', { name: 'Remove document same-file.txt', exact: true }).waitFor()
        await pane.locator('[data-document-status="ready"]').waitFor()
        if (index === 0) {
          await expect.poll(async () => (await personal.ctx.userDocs.list()).length).toBe(1)
          expect(await project.ctx.userDocs.list()).toEqual([])
        }
      }
      for (const [index, runtime] of runtimes.entries()) {
        const documents = runtime.ctx.get('userDocs')
        if (documents === undefined) throw new Error('The Web composition must provide User Documents')
        await expect.poll(async () => (await documents.list()).length).toBe(1)
        const file = (await documents.list())[0]!
        expect(file.name).toBe('same-file.txt')
        expect(new TextDecoder().decode((await documents.read(file.docId)).data)).toBe(`runtime ${index}`)
        expect(await readFile(file.path, 'utf8')).toBe(`runtime ${index}`)
      }
      await first.getByRole('button', { name: 'Remove document same-file.txt', exact: true }).click()
      await expect.poll(async () => (await personal.ctx.userDocs.list()).length).toBe(0)
      expect((await project.ctx.userDocs.list()).length).toBe(1)
      await second.getByRole('button', { name: 'Remove document same-file.txt', exact: true }).click()
      await expect.poll(async () => (await project.ctx.userDocs.list()).length).toBe(0)
      await compareOrRefreshGolden(SNAPSHOT, await captureStableAria(page, '[data-workbench-toolbar]', personal.workspaceCwd), webSnapshotMode())
      const discovery = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      releaseList = () => { released.resolve(undefined) }
      heldList = {
        baseUrl: bootstrap === 'personal' ? project.baseUrl : personal.baseUrl,
        arrived: () => { discovery.resolve(undefined) }, release: released.promise,
      }
      const reload = Promise.all([listed('personal'), listed('project:7'), page.reload({ waitUntil: 'load' })])
        .then(() => undefined, (error: unknown) => error)
      await discovery.promise
      const unloaded = `[data-session-pane="${bootstrap === 'personal' ? projectKey : personalKey}"] [role="status"]`
      await page.locator(unloaded).waitFor()
      await compareOrRefreshGolden(NOT_LOADED, await captureStableAria(page, unloaded, personal.workspaceCwd), webSnapshotMode())
      heldList = undefined
      releaseList()
      const reloadFailure = await reload
      if (reloadFailure !== undefined) throw reloadFailure
      await page.waitForLoadState('networkidle')
      expect(await page.locator('[data-session-pane]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')))).toEqual([personalKey, projectKey])
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
      await expect.poll(() => page.locator('[data-session-pane]').count()).toBe(0)
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await Promise.all([
        listed(bootstrap === 'personal' ? 'project:7' : 'personal'),
        page.getByRole('menuitem', { name: /我的工作台/ }).click(),
      ])
      await page.waitForLoadState('networkidle')
      expect(await page.locator('[data-session-pane]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-session-pane')))).toEqual([personalKey, projectKey])
      await page.locator(`[data-session-pane="${projectKey}"]`).getByRole('button', { name: 'Close pane', exact: true }).click()
      expect(await page.locator(`[data-session-pane="${personalKey}"]`).count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
      expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.workbenches.v3.local'))).not.toBeNull()
      personalComplete = false
      await page.evaluate((rawId) => {
        localStorage.removeItem('dsh.conversation.workbenches.v3.local')
        localStorage.setItem('dsh.conversation.workbenches.v2.local', JSON.stringify({
          version: 2, mode: 'workbench', activeId: 'legacy', workbenches: [{
            id: 'legacy', name: 'Legacy layout', paneIds: [rawId], activePaneId: rawId, paneRatios: [1], updatedAt: 1,
          }],
        }))
      }, id)
      await page.reload({ waitUntil: 'load' })
      await toolbar.getByRole('button', { name: 'Retry directory', exact: true }).waitFor()
      expect(await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).isDisabled()).toBe(true)
      expect(await page.locator('[data-session-pane]').count()).toBe(0)
      await compareOrRefreshGolden(LEGACY_PENDING, await captureStableAria(page, '[data-workbench-toolbar]', personal.workspaceCwd), webSnapshotMode())
      personalComplete = true
      await toolbar.getByRole('button', { name: 'Retry directory', exact: true }).click()
      await expect.poll(() => toolbar.getByRole('button', { name: 'Add conversation', exact: true }).isEnabled()).toBe(true)
      expect(await page.locator('[data-session-pane]').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      releaseList?.()
      await browser.close()
      for (const upstream of requests) upstream.destroy()
      for (const socket of sockets) socket.destroy()
      if (server !== undefined) await new Promise<void>((resolve, reject) => {
        server!.close((error) => { if (error) reject(error); else resolve() })
      })
      for (const runtime of runtimes.reverse()) await runtime.close()
    }
  }, 180_000,
)
