/** Two real Web runtimes with colliding durable IDs behind a bounded test router. */
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page, type Route } from 'playwright'
import { expect, it } from 'vitest'
import { saveFailureShot } from './support.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import { launchWebScaffold, seedSession, fixtureUserPrompts, watchConsole,
  captureStableAria, compareOrRefreshGolden, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const REPLY = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const SNAPSHOT = fileURLToPath(new URL('./snapshots/runtime-identity/panes.expected.md', import.meta.url))
const NOT_LOADED = fileURLToPath(new URL('./snapshots/runtime-identity/not-loaded.expected.md', import.meta.url))
const LEGACY_PENDING = fileURLToPath(new URL('./snapshots/runtime-identity/legacy-pending.expected.md', import.meta.url))
const ARCHIVE_READS = fileURLToPath(new URL('./expected/runtime-identity/archive-reads.expected.md', import.meta.url))
const DOCUMENT_SCOPES = fileURLToPath(new URL('./expected/runtime-identity/', import.meta.url))
const RESTORED_BINDINGS = fileURLToPath(new URL('./expected/runtime-identity/restored-bindings.expected.md', import.meta.url))
const PLUGINS_NAVIGATION = fileURLToPath(new URL('./expected/runtime-identity/plugins-navigation/', import.meta.url))
const HIDDEN_SUBMISSIONS = fileURLToPath(new URL('./expected/runtime-identity/hidden-submissions/', import.meta.url))
const SIDEBAR_STARTUP = fileURLToPath(new URL('./expected/runtime-identity/sidebar-startup/', import.meta.url))

it.skipIf(webSnapshotMode() === 'record').each(['personal', 'project'] as const)(
  'keeps identical Session IDs independent through histories, uploads and restoration from a %s bootstrap', async (bootstrap) => {
    const runtimes: WebScaffold[] = []
    const sockets = new Set<Socket>()
    const requests = new Set<ReturnType<typeof request>>()
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    let server: ReturnType<typeof createServer> | undefined
    let heldList: { baseUrl: string; arrived: () => void; release: Promise<undefined> } | undefined
    let releaseList: (() => void) | undefined
    let releasePrompt: (() => void) | undefined
    let promptDelivery: Promise<void> | undefined
    let personalComplete = true
    const workspaceReads = new Map<string, number>()
    const sessionCalls = new Map<string, number>()
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
      const sessionCookies = new Map<string, string>()
      const selected = (url: string | undefined): string => {
        const params = new URL(url ?? '/', 'http://fixture').searchParams
        const target = params.get('scope') ?? params.get('dshTarget')
        return target === 'project:7' || (target === null && bootstrap === 'project') ? project.baseUrl : personal.baseUrl
      }
      server = createServer((req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://fixture').pathname
        if (pathname === '/api/workspace.list') {
          const owner = selected(req.url)
          workspaceReads.set(owner, (workspaceReads.get(owner) ?? 0) + 1)
        }
        if (/^\/api\/session\.(?:history|historyIndex|create|prompt|cancel)$/.test(pathname)) {
          const key = `${selected(req.url)}${pathname}`
          sessionCalls.set(key, (sessionCalls.get(key) ?? 0) + 1)
        }
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
        // The router terminates browser authentication: each upstream minted a
        // session cookie bound to this router's authority, and the proxy swaps
        // the selected runtime's cookie into every forwarded request.
        const headers = {
          ...req.headers,
          cookie: sessionCookies.get(selected(req.url)) ?? '',
          ...(pathname === '/api/host.describe' ? { 'accept-encoding': 'identity' } : {}),
        }
        const upstreamUrl = new URL(req.url ?? '/', selected(req.url))
        // This fixture supplies only Gateway routing; each Host owns its document bytes and listing.
        if (pathname === '/api/documents/scope') upstreamUrl.pathname = '/api/documents'
        const upstream = request(upstreamUrl, { method: req.method, headers }, (response) => {
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
        const upstream = request(new URL(req.url ?? '/', selected(req.url)), {
          headers: { ...req.headers, cookie: sessionCookies.get(selected(req.url)) ?? '' },
        })
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
      const routerAuthority = `127.0.0.1:${String((server.address() as AddressInfo).port)}`
      for (const runtime of runtimes) {
        const exchange = new URL(runtime.ctx.connection.authenticatedUrl(`http://${routerAuthority}`))
        let setCookie: string | undefined
        const authorized = runtime.ctx.connection.authorizeIndex({
          method: 'GET',
          url: `${exchange.pathname}${exchange.search}`,
          headers: { host: exchange.host },
        }, {
          writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
          end() {},
        })
        if (authorized || setCookie === undefined) {
          throw new Error('runtime-identity: router-authority token exchange did not return a session cookie')
        }
        sessionCookies.set(runtime.baseUrl, setCookie.split(';', 1)[0] ?? '')
      }
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' })
      await page.route('**/api/documents/transfer/directories', async (route) => {
        const body = route.request().postDataJSON() as { scope: { kind: 'personal' | 'project' } }
        const owner = body.scope.kind === 'project' ? project : personal
        await route.fulfill({ json: { version: 1, directories: await owner.ctx.userDocs.listDirectories() } })
      })
      failurePage = page
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
      await page.getByRole('menuitem', { name: /My workbench/ }).click()
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
      const alternate = heldList.baseUrl
      const archiveReadsBefore = workspaceReads.get(alternate) ?? 0
      const reload = Promise.all([listed('personal'), listed('project:7'), page.reload({ waitUntil: 'load' })])
        .then(() => undefined, (error: unknown) => error)
      await discovery.promise
      const unloaded = `[data-session-pane="${bootstrap === 'personal' ? projectKey : personalKey}"] [role="status"]`
      await page.locator(unloaded).waitFor()
      await compareOrRefreshGolden(NOT_LOADED, await captureStableAria(page, unloaded, personal.workspaceCwd), webSnapshotMode())
      const foregroundSidebar = page.locator('[data-sidebar-right-session]:not([data-sidebar-right-panel]):not([hidden])')
      const pendingOwners = bootstrap === 'personal' ? [] : [projectKey]
      await expect.poll(() => foregroundSidebar.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sidebar-right-session')))).toEqual(pendingOwners)
      const sidebarStartup = [`Foreign Runtime list held\nSelected sidebar Session views: ${pendingOwners.length}\nWrong first-pane sidebar: false`]
      heldList = undefined
      releaseList()
      const reloadFailure = await reload
      if (reloadFailure !== undefined) throw reloadFailure
      await page.waitForLoadState('networkidle')
      expect(await foregroundSidebar.getAttribute('data-sidebar-right-session')).toBe(projectKey)
      sidebarStartup.push('Restored Runtime selection\nSidebar Session: Project collision')
      if (webSnapshotMode() === 'refresh') await mkdir(SIDEBAR_STARTUP, { recursive: true })
      await compareOrRefreshGolden(`${SIDEBAR_STARTUP}${bootstrap}.expected.md`, sidebarStartup.join('\n\n'), webSnapshotMode())
      expect(await page.locator('[data-session-pane]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-pane')))).toEqual([personalKey, projectKey])
      const archiveReads = (workspaceReads.get(alternate) ?? 0) - archiveReadsBefore
      expect(archiveReads).toBe(1)
      await compareOrRefreshGolden(ARCHIVE_READS,
        `Alternate Runtime Workspace reads during restoration: ${archiveReads}\nRestored panes: 2`, webSnapshotMode())
      await Promise.all([first.locator('textarea').waitFor(), second.locator('textarea').waitFor()])
      const editable = await Promise.all([first.locator('textarea').isEditable(), second.locator('textarea').isEditable()])
      expect(editable).toEqual([true, true])
      const unavailable = await page.locator('[data-session-pane]').getByText('This conversation is not loaded. Start and open its workspace, then try again.', { exact: true }).count()
      expect(unavailable).toBe(0)
      expect(await page.locator('[data-session-pane][data-active]').getAttribute('data-session-pane')).toBe(projectKey)
      await compareOrRefreshGolden(RESTORED_BINDINGS,
        `Restored editable panes: ${editable.filter(Boolean).length}\nUnavailable panes: ${unavailable}`, webSnapshotMode())
      // Empty input leaves the logical Workbench as the foreign Runtime's
      // owner; an unsent draft would independently keep that Runtime alive.
      expect(await Promise.all([first, second].map(pane => pane.locator('textarea').inputValue()))).toEqual(['', ''])
      const caption = toolbar.getByRole('button', { name: 'Select workbench', exact: true })
      await caption.click()
      await page.getByRole('menuitem', { name: 'Duplicate workbench', exact: true }).click()
      const duplicate = page.getByRole('dialog', { name: 'Duplicate workbench', exact: true })
      await duplicate.getByRole('textbox', { name: 'Workbench name', exact: true }).fill('Navigation B')
      await duplicate.getByRole('button', { name: 'Confirm', exact: true }).click()
      await duplicate.waitFor({ state: 'hidden' })
      await caption.click()
      await page.getByRole('menuitem', { name: 'My workbench · 2/4', exact: true }).click()
      const savedMembers = () => page.evaluate(() => {
        const raw = localStorage.getItem('dsh.conversation.workbenches.v3.local')
        if (raw === null) throw new Error('Private Runtime fixture has no saved Workbench record')
        const record = JSON.parse(raw) as { workbenches: { name: string; paneIds: string[] }[] }
        return record.workbenches.map(row => ({ name: row.name, paneIds: row.paneIds }))
      })
      const members = [{ name: '', paneIds: [personalKey, projectKey] }, { name: 'Navigation B', paneIds: [personalKey, projectKey] }]
      expect(await savedMembers()).toEqual(members)
      if (webSnapshotMode() === 'refresh') await mkdir(PLUGINS_NAVIGATION, { recursive: true })
      for (const [focusIndex, pane] of [first, second].entries()) {
        const focusedKey = focusIndex === 0 ? personalKey : projectKey
        await pane.locator('textarea').click()
        expect(await pane.getAttribute('data-active')).toBe('true')
        const callsBefore = [...sessionCalls]
        expect(callsBefore.some(([method, count]) => method.endsWith('/api/session.history') && count > 0)).toBe(true)
        await page.getByRole('button', { name: 'Plugins', exact: true }).click()
        // Membership precedes panel readiness: retiring a focused foreign
        // Runtime may select the bootstrap Session and close Plugins itself.
        expect(await savedMembers()).toEqual(members)
        const sidebar = page.getByRole('region', { name: 'Workbench', exact: true })
        expect(await sidebar.getByRole('listitem').count()).toBe(2)
        const selectedRow = sidebar.getByRole('listitem').nth(focusIndex).getByRole('button').first()
        expect(await selectedRow.getAttribute('aria-current')).toBe('true')
        await page.locator('[data-plugin-panel]').waitFor()
        expect(await page.locator('[data-session-pane]').count()).toBe(0)
        await selectedRow.click()
        await expect.poll(() => page.locator('[data-session-pane]').evaluateAll(nodes =>
          nodes.map(node => node.getAttribute('data-session-pane')))).toEqual([personalKey, projectKey])
        expect(await page.locator('[data-session-pane][data-active]').getAttribute('data-session-pane')).toBe(focusedKey)
        expect(await Promise.all([first, second].map(candidate => candidate.locator('textarea').isEditable())))
          .toEqual([true, true])
        expect([...sessionCalls]).toEqual(callsBefore)
        expect(await savedMembers()).toEqual(members)
        console.info('[runtime-identity-plugins-navigation]', JSON.stringify({
          bootstrap, focusedRealm: focusIndex === 0 ? 'personal' : 'project',
          before: callsBefore, after: [...sessionCalls], namedMembersUnchanged: true,
        }))
        await caption.click()
        await page.getByRole('menuitem', { name: 'My workbench · 2/4', exact: true }).waitFor()
        await page.getByRole('menuitem', { name: 'Navigation B · 2/4', exact: true }).waitFor()
        const focusName = focusIndex === 0 ? 'personal' : 'project'
        await compareOrRefreshGolden(`${PLUGINS_NAVIGATION}${bootstrap}-${focusName}.expected.md`,
          await captureStableAria(page, '[role="menu"]', personal.workspaceCwd), webSnapshotMode())
        await page.keyboard.press('Escape')
      }
      const sender = bootstrap === 'personal' ? first : second
      const other = bootstrap === 'personal' ? second : first
      const senderKey = bootstrap === 'personal' ? personalKey! : projectKey!
      const senderIndex = bootstrap === 'personal' ? 0 : 1
      const admission = Promise.withResolvers<undefined>()
      const deliveryGate = Promise.withResolvers<undefined>()
      releasePrompt = () => { deliveryGate.resolve(undefined) }
      const promptRoute = /\/api\/session\.prompt(?:\?|$)/
      const holdAdmission = (route: Route): Promise<void> => {
        const pending = (async () => {
          const response = await route.fetch()
          try {
            expect(response.status()).toBe(200)
            admission.resolve(undefined)
            await deliveryGate.promise
            await route.fulfill({ response })
          } finally {
            await response.dispose()
          }
        })()
        promptDelivery = pending
        void pending.catch((error: unknown) => { admission.reject(error) })
        return pending
      }
      await page.route(promptRoute, holdAdmission)
      const otherDraft = `Unsent ${bootstrap === 'personal' ? 'project' : 'personal'} draft stays separate`
      await other.locator('textarea').fill(otherDraft)
      await sender.locator('textarea').fill(prompt)
      const settled = runtimes[senderIndex]!.whenTurnSettled()
      await sender.locator('textarea').press('Enter')
      await admission.promise
      const storedDraft = () => page.evaluate((key) => {
        const value = localStorage.getItem(`dsh.conversation.chat.${key}`)
        if (value === null) throw new Error('Expected the sender draft store')
        return (JSON.parse(value) as { draft: unknown }).draft
      }, senderKey)
      expect(await storedDraft()).toBe(prompt)
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.locator('[data-plugin-panel]').waitFor()
      expect(await page.locator('[data-session-pane]').count()).toBe(0)
      deliveryGate.resolve(undefined)
      await promptDelivery
      expect(await settled).toBe(id)
      await expect.poll(storedDraft).toBe('')
      expect(await savedMembers()).toEqual(members)
      await page.unroute(promptRoute, holdAdmission)
      releasePrompt = undefined
      await page.reload({ waitUntil: 'load' })
      const senderRow = page.getByRole('region', { name: 'Workbench', exact: true })
        .getByRole('listitem').nth(senderIndex).getByRole('button').first()
      await senderRow.click()
      await expect.poll(() => page.locator('[data-session-pane]').count()).toBe(2)
      await expect.poll(() => sender.locator('textarea').inputValue()).toBe('')
      expect(await other.locator('textarea').inputValue()).toBe(otherDraft)
      expect(await savedMembers()).toEqual(members)
      if (webSnapshotMode() === 'refresh') await mkdir(HIDDEN_SUBMISSIONS, { recursive: true })
      await compareOrRefreshGolden(`${HIDDEN_SUBMISSIONS}${bootstrap}.expected.md`,
        `Accepted sender after reload:\n${await captureStableAria(page, `[data-session-pane="${senderKey}"] textarea`, personal.workspaceCwd)}\n` +
        `Other unsent draft:\n${await captureStableAria(page, `[data-session-pane="${bootstrap === 'personal' ? projectKey! : personalKey!}"] textarea`, personal.workspaceCwd)}`,
        webSnapshotMode())
      await other.locator('textarea').fill('')
      // Restore this fixture's original single named layout before its
      // document-scope and legacy-identity scenarios continue.
      await caption.click()
      await page.getByRole('menuitem', { name: 'Navigation B · 2/4', exact: true }).click()
      await caption.click()
      await page.getByRole('menuitem', { name: 'Delete workbench', exact: true }).click()
      const deleteWorkbench = page.getByRole('dialog', { name: 'Delete workbench', exact: true })
      await deleteWorkbench.getByRole('button', { name: 'Confirm', exact: true }).click()
      await deleteWorkbench.waitFor({ state: 'hidden' })
      expect(await savedMembers()).toEqual(members.slice(0, 1))
      const documentNames = ['personal-scope.txt', 'project-scope.txt']
      for (const [index, runtime] of runtimes.entries()) {
        const target = await runtime.ctx.userDocs.resolveTarget({ name: documentNames[index]! })
        await runtime.ctx.userDocs.save(target, new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(`scope ${index}`)); controller.close() },
        }))
      }
      const alternatePane = bootstrap === 'personal' ? second : first
      await alternatePane.locator('textarea').click()
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await page.getByRole('menuitem', { name: 'Exit workbench', exact: true }).click()
      await expect.poll(() => page.locator('[data-session-pane]').count()).toBe(0)
      await page.getByRole('button', { name: 'Documents', exact: true }).click()
      const manager = page.getByRole('dialog', { name: /^(?:Document Manager|Project Documents: Project realm)$/ })
      await manager.getByRole('heading', {
        name: bootstrap === 'personal' ? 'Document Manager' : 'Project Documents: Project realm', exact: true,
      }).waitFor()
      const runtimeIndex = bootstrap === 'personal' ? 0 : 1
      const targetIndex = 1 - runtimeIndex
      await manager.getByText(documentNames[runtimeIndex]!, { exact: true }).waitFor()
      const targetLabel = bootstrap === 'personal' ? 'Project realm' : 'Personal documents'
      const documentCheckbox = manager.getByRole('checkbox', { name: documentNames[runtimeIndex]!, exact: true })
      await documentCheckbox.check()
      await manager.getByRole('button', { name: 'Copy to another scope', exact: true }).click()
      const copyDialog = page.getByRole('dialog', { name: 'Copy Document Snapshots', exact: true })
      const choices = copyDialog.getByRole('radiogroup', { name: 'Target scope', exact: true })
      expect(await choices.locator('input[type="radio"]').evaluateAll(options => options.map(option => option.getAttribute('value'))))
        .toEqual([bootstrap === 'personal' ? 'project:7' : 'personal'])
      const copyDestination = await choices.locator('label').innerText()
      await copyDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await documentCheckbox.uncheck()
      const [alternateRead] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url())
          return url.pathname === '/api/documents/scope'
            && url.searchParams.get('scope') === (bootstrap === 'personal' ? 'project:7' : 'personal')
        }),
        manager.getByRole('button', { name: new RegExp(targetLabel) }).click(),
      ])
      expect(alternateRead.status()).toBe(200)
      await manager.getByText(documentNames[targetIndex]!, { exact: true }).waitFor()
      const viewing = manager.getByText(`Upload target: ${targetLabel}`, { exact: true }).filter({ visible: true })
      await viewing.waitFor()
      await compareOrRefreshGolden(`${DOCUMENT_SCOPES}${bootstrap}-documents.expected.md`,
        `Copy destination: ${copyDestination}\n${await viewing.innerText()}\n${await manager.getByRole('button', { name: `Preview ${documentNames[targetIndex]!}`, exact: true }).getAttribute('aria-label')}`,
        webSnapshotMode())
      await manager.getByRole('button', { name: new RegExp(bootstrap === 'personal' ? 'Personal documents' : 'Project realm') }).click()
      await manager.getByText(documentNames[runtimeIndex]!, { exact: true }).waitFor()
      expect(await manager.getByText(documentNames[targetIndex]!, { exact: true }).count()).toBe(0)
      await manager.getByRole('button', { name: 'Close', exact: true }).click()
      await toolbar.getByRole('button', { name: 'Select workbench' }).click()
      await page.getByRole('menuitem', { name: /My workbench/ }).click()
      await page.waitForLoadState('networkidle')
      await expect.poll(() => page.locator('[data-session-pane]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-session-pane')))).toEqual([personalKey, projectKey])
      await page.locator(`[data-session-pane="${projectKey}"]`).locator('[data-pane-drag]').hover()
      await page.locator(`[data-session-pane="${projectKey}"]`).getByRole('button', { name: 'Close pane', exact: true }).click()
      expect(await page.locator(`[data-session-pane="${personalKey}"]`).count()).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
      expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.workbenches.v3.local'))).not.toBeNull()
      personalComplete = false
      // Seed the legacy generation before the next client owns persistence; the outgoing document may still save its live layout.
      await page.addInitScript((rawId) => {
        localStorage.removeItem('dsh.conversation.workbenches.v3.local')
        localStorage.setItem('dsh.conversation.workbenches.v2.local', JSON.stringify({
          version: 2, mode: 'workbench', activeId: 'legacy', workbenches: [{
            id: 'legacy', name: 'Legacy layout', paneIds: [rawId], activePaneId: rawId, paneRatios: [1], updatedAt: 1,
          }],
        }))
      }, id)
      await page.reload({ waitUntil: 'load' })
      await toolbar.getByRole('button', { name: 'Reload directory', exact: true }).waitFor()
      expect(await toolbar.getByRole('button', { name: 'Add conversation', exact: true }).isDisabled()).toBe(true)
      expect(await page.locator('[data-session-pane]').count()).toBe(0)
      await compareOrRefreshGolden(LEGACY_PENDING, await captureStableAria(page, '[data-workbench-toolbar]', personal.workspaceCwd), webSnapshotMode())
      personalComplete = true
      await toolbar.getByRole('button', { name: 'Reload directory', exact: true }).click()
      await toolbar.getByRole('button', { name: 'Confirm original conversation environments', exact: true }).click()
      const restoreDialog = page.getByRole('dialog', { name: 'Confirm original conversation environments', exact: true })
      await restoreDialog.getByRole('combobox').selectOption({ label: 'Remove pane and retain conversation' })
      await restoreDialog.getByRole('button', { name: 'Restore workbench', exact: true }).click()
      await expect.poll(() => toolbar.getByRole('button', { name: 'Add conversation', exact: true }).isEnabled()).toBe(true)
      expect(await page.locator('[data-session-pane]').count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } catch (cause) {
      if (failurePage !== undefined) {
        await saveFailureShot(failurePage, `runtime-identity-${bootstrap}`)
        const state = await Promise.allSettled([failurePage.locator('[data-workbench-toolbar]').ariaSnapshot(),
          failurePage.evaluate(() => ({ url: location.href, keys: Object.keys(localStorage).filter(key => key.includes('workbenches')) }))])
        console.error('Runtime restoration state:', JSON.stringify(state))
      }
      throw cause
    } finally {
      releaseList?.()
      releasePrompt?.()
      const deliveryResults = await Promise.allSettled(promptDelivery === undefined ? [] : [promptDelivery])
      await browser.close()
      for (const upstream of requests) upstream.destroy()
      for (const socket of sockets) socket.destroy()
      if (server !== undefined) await new Promise<void>((resolve, reject) => {
        server!.close((error) => { if (error) reject(error); else resolve() })
      })
      for (const runtime of runtimes.reverse()) await runtime.close()
      if (deliveryResults[0]?.status === 'rejected') throw deliveryResults[0].reason
    }
  }, 180_000,
)

it('owns the Runtime Plugins navigation and hidden-submission goldens', async () => {
  expect((await readdir(PLUGINS_NAVIGATION)).sort()).toEqual([
    'personal-personal.expected.md', 'personal-project.expected.md',
    'project-personal.expected.md', 'project-project.expected.md',
  ])
  expect((await readdir(HIDDEN_SUBMISSIONS)).sort()).toEqual(['personal.expected.md', 'project.expected.md'])
  expect((await readdir(SIDEBAR_STARTUP)).sort()).toEqual(['personal.expected.md', 'project.expected.md'])
})
