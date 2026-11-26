/** Authenticated, built Admin page backed by two Gateways and one real Runtime process. */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

/** Install a scoped administrator and project the owned SQLite process into the two fixture catalogs. */
export async function installAdminStartFixture({ users, remoteUsers, center, remote, localNodeId,
  remoteManager, environment, actor, runtimeId, hasStarted }) {
  const administrator = await users.create({ username: 'administrator', password: 'fixture-password-12345', role: 'admin' })
  await users.changeOwnPassword(administrator.id, 'fixture-password-12345')
  await remoteUsers.create({ username: 'other', password: 'fixture-password-12345' })
  const remoteAdmin = await remoteUsers.create({ username: 'administrator', password: 'fixture-password-12345', role: 'admin' })
  await remoteUsers.changeOwnPassword(remoteAdmin.id, 'fixture-password-12345')
  assert.equal(remoteAdmin.id, administrator.id)
  const context = { mode: 'multi', revision: '1', entry: { nodeId: localNodeId, name: 'Center' },
    primary: { nodeId: localNodeId, name: 'Center', origin: 'https://fixture.invalid' },
    scope: 'organization', role: 'primary', refreshAfterMs: 30_000, legacyMigrationRequired: false }
  center.nodeServiceIdentity = { nodeId: localNodeId, organizationId: remote.nodeServiceIdentity.organizationId }
  Object.assign(center.topology, { read: async () => context, adminRead: async () => context })
  const fixturePolicy = { policy: async () => ({ maxTotal: 8, maxPerNode: 4, revision: '1', source: 'organization' }) }
  center.runtimeManagement = remote.runtimeManagement = fixturePolicy
  const resolveForAdministrator = async (user, id) => {
    assert.equal(user.id, administrator.id)
    assert.equal(id, runtimeId)
    const target = { kind: 'user', id: actor.id, runtimeId }
    const observedState = await remoteManager.stateOf(target)
    // The isolated SQLite owner has exactly one generation. Before its first admission it has none.
    return { ...environment, observedState, generation: !hasStarted() ? 0 : await remoteManager.generationOf(target) }
  }
  remote.runtimeCatalog = { resolveForAdministrator }
  Object.assign(center.runtimeCatalog, { resolveForAdministrator,
    pageForAdministratorOwner: async (user, owner) => {
      assert.deepEqual(owner, { kind: 'personal', id: actor.id })
      return { items: [await resolveForAdministrator(user, runtimeId)], nextCursor: null }
    } })
  return resolveForAdministrator
}

/** Exercise a lost submitted response while the remote launcher is held behind the fixture gate. */
export async function observeAdminStart({ origin, runtimeId, nodeId, userId, transcript, dropReply, allowReadiness, bounded }) {
  const browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER_EXECUTABLE })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
    page.setDefaultTimeout(12_000)
    const detail = `/admin/api/runtimes/${runtimeId}`, start = detail + '/start'
    const requests = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === detail || url.pathname === start) requests.push({ method: request.method(), url })
    })
    const login = await page.request.post(origin + '/login', { form: { username: 'administrator', password: 'fixture-password-12345' },
      headers: { origin }, maxRedirects: 0 })
    assert.equal(login.status(), 302)
    await page.goto(`${origin}/admin/users/${userId}`)
    const row = page.getByRole('row').filter({ hasText: runtimeId })
    await row.getByRole('button', { name: '启动', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const submit = dialog.getByRole('button', { name: '启动', exact: true })
    // CDP never exposes error-response bodies to getResponseBody once the
    // renderer consumes them, so proxy the start reply: route.fetch performs
    // the genuine round trip while the test captures status and body directly.
    const reply = Promise.withResolvers()
    await page.route((url) => url.pathname === start, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      reply.resolve({ status: response.status(), body: await response.json() })
      await route.fulfill({ response })
    })
    await submit.click()
    await dropReply()
    const response = await bounded(reply.promise)
    assert.equal(response.status, 503)
    assert.equal(response.body.error, 'node-service/unavailable')
    const checking = dialog.getByRole('status')
    await checking.waitFor()
    assert.equal(await submit.isDisabled(), true)
    const pending = await checking.innerText()
    assert.match(pending, /正在核实/)
    transcript.push('POST 503 · ' + pending)
    const firstRead = await page.request.get(origin + detail)
    assert.equal(firstRead.status(), 200)
    assert.deepEqual(await firstRead.json().then(row => [row.id, row.node.id, row.generation, row.observedState]),
      [runtimeId, nodeId, 1, 'starting'])
    allowReadiness()
    const notice = page.getByRole('status').filter({ hasText: '所选 Runtime 已就绪' })
    await notice.waitFor()
    const finalRead = await page.request.get(origin + detail)
    assert.deepEqual(await finalRead.json().then(row => [row.id, row.node.id, row.generation, row.observedState]),
      [runtimeId, nodeId, 1, 'ready'])
    const posted = requests.filter(request => request.method === 'POST')
    assert.equal(posted.length, 1)
    assert.deepEqual(Object.fromEntries(posted[0].url.searchParams), { dshRuntime: runtimeId, dshNode: nodeId })
    const reads = requests.filter(request => request.method === 'GET')
    assert.ok(reads.length >= 1 && reads.every(request => request.url.pathname === detail && request.url.search === ''))
    transcript.push('GET ready · ' + await notice.innerText())
    transcript.push('One start on the selected computer. Read-only checks confirm the same allocation and signed generation.')
  } finally { await browser.close() }
}
