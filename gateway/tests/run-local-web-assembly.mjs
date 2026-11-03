/** Real PostgreSQL/Gateway/Web-profile lifecycle with stable, kernel-allocated front doors. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { writeTunnelBinary } from './fixtures/tunnel-binary.mjs'

const plane = process.argv[2] ?? 'lib'
assert.ok(plane === 'lib' || plane === 'src')
const directoryCase = process.env.LOCAL_WEB_DIRECTORY_CASE
const documentCase = process.env.LOCAL_WEB_DOCUMENT_CASE ?? (process.argv[3] === 'documents' ? 'normal' : undefined)
assert.ok(documentCase === undefined || documentCase === 'normal')
assert.ok(directoryCase === undefined || directoryCase === 'readonly' || directoryCase === 'empty' || directoryCase === 'replacement')
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(databaseUrl)
const moduleUrl = name => plane === 'lib' && process.env.LOCAL_WEB_GATEWAY_ARTIFACT !== undefined
  ? pathToFileURL(join(process.env.LOCAL_WEB_GATEWAY_ARTIFACT, `${name}.js`))
  : new URL(`../${plane}/${name}.${plane === 'src' ? 'ts' : 'js'}`, import.meta.url)
const { createPostgresPool, runMigrations } = await import(moduleUrl('postgres/database'))
const { LocalRuntimeOwnerStore } = await import(moduleUrl('local-runtime-owner'))
const { LocalRuntimeControl } = await import(moduleUrl('local-runtime-control'))
const pool = createPostgresPool(databaseUrl, { max: 2 })
await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations', import.meta.url)))

async function relay(resolvePort) {
  const sockets = new Set()
  let port
  const server = createServer(downstream => {
    sockets.add(downstream); downstream.once('close', () => sockets.delete(downstream))
    void (async () => {
      const selected = resolvePort === undefined ? port : await resolvePort()
      if (!selected) { downstream.destroy(); return }
      const upstream = connect({ host: '127.0.0.1', port: selected })
      sockets.add(upstream); upstream.once('close', () => { sockets.delete(upstream); downstream.destroy() })
      upstream.once('error', () => downstream.destroy()); downstream.once('error', () => upstream.destroy())
      downstream.once('close', () => upstream.destroy()); downstream.pipe(upstream).pipe(downstream)
    })().catch(() => downstream.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    publish(value) { for (const socket of sockets) socket.destroy(); port = value },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

async function removeOrganization(id) {
  const tables = (await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
    WHERE c.table_schema='harness' AND c.column_name='organization_id' AND t.table_type='BASE TABLE'`)).rows.map(row => row.table_name)
  for (let round = 0; round <= tables.length; round++) {
    for (const table of tables) {
      assert.match(table, /^[a-z][a-z0-9_]+$/u)
      try { await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [id]) }
      catch (error) { if (error.code !== '23503') throw error }
    }
    try { await pool.query('DELETE FROM harness.organizations WHERE id=$1', [id]); return }
    catch (error) { if (error.code !== '23503') throw error }
  }
  throw new Error('Owned Web assembly organization cleanup could not finish')
}

async function assertConnectorClosed(witness) {
  let remaining
  try { remaining = await (await fetch(witness.controlUrl)).text() } catch (error) {
    if (!(error instanceof TypeError && error.cause && ['ECONNREFUSED', 'ECONNRESET'].includes(error.cause.code))) throw error
  }
  assert.notEqual(remaining, witness.probeToken)
}

const transcript = []
try {
  for (const scope of ['personal', 'project']) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-web-assembly-')), slug = `web-assembly-${randomUUID()}`
    const organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Web assembly') RETURNING id", [slug])).rows[0].id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'fixture')", [organization])
    let dshHome, active, prepareShutdownTunnel
    const children = [], relays = []
    let runtimePort
    try {
      const publicRelay = await relay(), intakeRelay = await relay()
      relays.push(publicRelay, intakeRelay)
      const runtimeRelay = await relay(async () => {
        if (dshHome === undefined) return undefined
        let log
        try { log = await readFile(join(dshHome, 'logs/runtime.log'), 'utf8') }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
        const match = [...log.matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/gu)].at(-1)
        return runtimePort = match === undefined ? undefined : Number(match[1])
      })
      relays.push(runtimeRelay)
      const base = `http://127.0.0.1:${publicRelay.port}`
      const runtimeUrl = pathname => {
        const url = new URL(pathname, base)
        url.searchParams.set('dshRuntime', active.ready.runtimeId)
        url.searchParams.set('dshTarget', scope === 'personal' ? 'personal' : `project:${active.ready.projectId}`)
        return url
      }
      async function startGateway() {
        const child = spawn(process.execPath, [...(plane === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
          fileURLToPath(new URL('./fixtures/local-runtime-web-gateway.mjs', import.meta.url))], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
            ...process.env, LOCAL_WEB_PLANE: plane, LOCAL_WEB_ROOT: root, LOCAL_WEB_ORGANIZATION: slug, LOCAL_WEB_SCOPE: scope, LOCAL_WEB_DOCUMENT_CASE: documentCase,
            DATABASE_URL: 'synthetic-database', CLOUD_CREDENTIALS: 'synthetic-cloud',
            LOCAL_WEB_PUBLIC_PORT: String(publicRelay.port), LOCAL_WEB_INTAKE_PORT: String(intakeRelay.port), LOCAL_WEB_RUNTIME_PORT: String(runtimeRelay.port),
            NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: plane === 'src' ? fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) : undefined,
          },
        })
        children.push(child)
        let diagnostics = ''
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-16000) })
        const messages = [], waiters = new Map()
        child.on('message', value => {
          if (value.kind === 'failure') { for (const waiter of waiters.values()) waiter.reject(new Error(value.message)); return }
          const waiter = waiters.get(value.kind)
          if (waiter) { waiters.delete(value.kind); waiter.resolve(value) } else messages.push(value)
        })
        const fail = error => { for (const waiter of waiters.values()) waiter.reject(error); waiters.clear() }
        child.once('error', fail); child.once('exit', () => fail(new Error(`Gateway fixture exited: ${diagnostics}`)))
        const receive = kind => {
          const index = messages.findIndex(value => value.kind === kind)
          if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0])
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiters.delete(kind); reject(new Error(`Gateway fixture did not report ${kind}: ${diagnostics}`)) }, 90000)
            waiters.set(kind, { resolve(value) { clearTimeout(timer); resolve(value) }, reject(error) { clearTimeout(timer); reject(error) } })
          })
        }
        const ready = await receive('ready'); dshHome = ready.dshHome
        publicRelay.publish(ready.backendPort); intakeRelay.publish(ready.intakePort)
        return { child, ready, async command(kind) { const reply = receive(kind === 'stop' ? 'stopped' : kind); child.send({ kind }); return await reply } }
      }
      active = await startGateway()
      async function login(username) {
        const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
          headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username, password: 'fixture-password' }) })
        await response.arrayBuffer(); assert.equal(response.status, 302)
        return response.headers.get('set-cookie').split(';')[0]
      }
      async function select(cookie) {
        const response = await fetch(runtimeUrl('/account/api/scope'), { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' },
          body: JSON.stringify(scope === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: active.ready.projectId }) })
        const body = await response.text()
        const diagnostics = response.status === 204 ? '' : await active.command('diagnostics').then(value => value.text, error => String(error))
        assert.equal(response.status, 204, `${body}\n${diagnostics}`)
        const selected = new URL(response.headers.get('location'), base)
        assert.equal(selected.searchParams.get('dshRuntime'), active.ready.runtimeId)
        const selectionCookie = response.headers.get('set-cookie')
        return selectionCookie === null ? cookie : `${cookie}; ${selectionCookie.split(';')[0]}`
      }
      const cookie = await select(await login(directoryCase === 'readonly' || directoryCase === 'replacement' ? 'peer' : 'fixture'))
      if (scope === 'personal' && directoryCase === undefined && documentCase === undefined) {
        const action = value => fetch(`${base}/admin/api/tunnel/actions`, { method: 'POST',
          headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(value) })
        const missing = await action({ action: 'start-quick' }); await missing.arrayBuffer()
        assert.equal(missing.status, 502)
        assert.equal((await active.command('tunnel-status')).view.state, 'error')
        transcript.push('tunnel: authenticated quick startup failure leaves Gateway available.')
        await writeTunnelBinary(root)
        async function witness(mode) {
          const deadline = performance.now() + 30000
          for (;;) {
            try {
              const value = JSON.parse(await readFile(join(root, `tunnel-${mode}.prepared`), 'utf8'))
              assert.ok(value.pathAvailable); assert.ok(Object.values(value.deploymentEnvironment).every(present => present === false))
              assert.equal(value.argumentTokenExposed, false); assert.equal(value.selectedTokenAvailable, mode === 'named')
              assert.equal(await (await fetch(value.controlUrl)).text(), value.probeToken)
              return value
            } catch (error) { if (error.code !== 'ENOENT') throw error }
            if (performance.now() >= deadline) throw new Error(`Tunnel ${mode} output did not drain`)
            await delay(25)
          }
        }
        prepareShutdownTunnel = async () => {
          await rm(join(root, 'tunnel-named.prepared'), { force: true })
          await rm(join(root, 'tunnel-named.register'), { force: true })
          const request = action({ action: 'start-named', hostname: 'fixture.example.com' })
            .then(async response => ({ status: response.status, body: await response.text() })).catch(error => ({ error }))
          const prepared = await witness('named')
          assert.equal((await active.command('tunnel-status')).view.state, 'starting')
          return { prepared, request }
        }
        const quickRequest = action({ action: 'start-quick' })
        await witness('quick')
        assert.equal((await active.command('tunnel-status')).view.state, 'starting')
        await writeFile(join(root, 'tunnel-quick.register'), 'register\n')
        const quick = await quickRequest; assert.equal(quick.status, 200); assert.equal((await quick.json()).state, 'running')
        const quickStop = await action({ action: 'stop' }); assert.equal(quickStop.status, 200); await quickStop.arrayBuffer()
        assert.equal(await readFile(join(root, 'tunnel-quick.stopped'), 'utf8'), 'closed\n')
        const input = { action: 'start-named', hostname: 'fixture.example.com', domain: 'example.com', apiToken: 'synthetic-api-token' }
        const retry = await action(input); assert.equal(retry.status, 502); await retry.arrayBuffer()
        const stored = (await pool.query('SELECT tunnel_id,run_token_cipher FROM harness.tunnel_access WHERE organization_id=$1', [organization])).rows[0]
        assert.equal(stored.tunnel_id, 'fixture-tunnel'); assert.equal(stored.run_token_cipher, null)
        const namedRequest = action(input)
        await witness('named')
        assert.equal((await active.command('tunnel-status')).view.state, 'starting')
        await writeFile(join(root, 'tunnel-named.register'), 'register\n')
        const named = await namedRequest; assert.equal(named.status, 200); assert.equal((await named.json()).state, 'running')
        transcript.push('tunnel: quick and named launches stay starting until their own connector registers.')
        const counts = await active.command('tunnel-status'); assert.equal(counts.creates, 1); assert.equal(counts.tokens, 2)
        transcript.push('tunnel: quick and named children drain output and exclude deployment credentials.')
        const namedStop = await action({ action: 'stop' }); assert.equal(namedStop.status, 200); await namedStop.arrayBuffer()
        assert.equal(await readFile(join(root, 'tunnel-named.stopped'), 'utf8'), 'closed\n')
        transcript.push('tunnel: token retrieval retries reuse the durable tunnel and stop confirms child closure.')
        const beforeCancel = await active.command('tunnel-status')
        await rm(join(root, 'tunnel-named.prepared')); await rm(join(root, 'tunnel-named.register'))
        const cancelledStart = action(input), cancelledChild = await witness('named')
        const cancelledQueued = action(input)
        const acceptedDeadline = performance.now() + 30000
        while ((await active.command('tunnel-status')).namedStarts !== beforeCancel.namedStarts + 2) {
          if (performance.now() >= acceptedDeadline) throw new Error('Queued tunnel start was not accepted')
          await delay(25)
        }
        const cancelledStop = await action({ action: 'stop' }); assert.equal(cancelledStop.status, 200); await cancelledStop.arrayBuffer()
        for (const result of [await cancelledStart, await cancelledQueued]) { assert.equal(result.status, 409); await result.arrayBuffer() }
        assert.equal((await active.command('tunnel-status')).namedAllocations, beforeCancel.namedAllocations + 1)
        await assertConnectorClosed(cancelledChild)
        transcript.push('tunnel: Stop cancels current registration and earlier queued starts before another allocation.')
        await rm(join(root, 'tunnel-named.prepared')); await rm(join(root, 'tunnel-named.register'), { force: true })
        const unregistered = action(input), blocked = await witness('named')
        assert.equal((await active.command('tunnel-status')).view.state, 'starting')
        const timeout = await unregistered; assert.equal(timeout.status, 502); await timeout.arrayBuffer()
        const failed = await active.command('tunnel-status')
        assert.equal(failed.view.state, 'error'); assert.equal(failed.view.publicUrl, null)
        await assertConnectorClosed(blocked)
        transcript.push('tunnel: missing connector registration reaches its configured deadline and closes the owned child.')
        const beforePrepare = await active.command('tunnel-status')
        await writeFile(join(root, 'hold-zone-request'), 'hold\n')
        const cancelledPrepare = action({ ...input, domain: 'example.com' })
        const prepareDeadline = performance.now() + 10000
        while ((await active.command('tunnel-status')).zoneRequests === beforePrepare.zoneRequests) {
          if (performance.now() >= prepareDeadline) throw new Error('Cloudflare preparation request was not observed')
          await delay(25)
        }
        const prepareStop = await action({ action: 'stop' }); assert.equal(prepareStop.status, 200); await prepareStop.arrayBuffer()
        const cancelledReply = await cancelledPrepare; assert.equal(cancelledReply.status, 409); await cancelledReply.arrayBuffer()
        const closeDeadline = performance.now() + 10000
        while ((await active.command('tunnel-status')).zoneAborts === beforePrepare.zoneAborts) {
          if (performance.now() >= closeDeadline) throw new Error('Cloudflare preparation transport did not close')
          await delay(25)
        }
        assert.equal((await active.command('tunnel-status')).namedAllocations, beforePrepare.namedAllocations)
        await rm(join(root, 'hold-zone-request'))
        transcript.push('tunnel: Stop aborts pending Cloudflare preparation without allocating another connector.')
      }
      const page = await fetch(runtimeUrl('/'), { headers: { cookie } }); const html = await page.text()
      assert.equal(page.status, 200); assert.match(html, /<!doctype html>/iu)
      const before = await active.command('status'); assert.equal(before.state, 'ready'); assert.equal(before.resident, 1)
      transcript.push(`${scope}: signed-in Gateway serves the real Web profile after registered readiness.`)
      async function directoryRpc(method, payload) {
        const response = await fetch(runtimeUrl(`/api/${method}`), { method: 'POST',
          headers: { origin: base, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }) })
        assert.equal(response.status, 200)
        return (await response.json()).result
      }
      if (documentCase !== undefined) {
        const inventory = await directoryRpc('pluginInventory/list', { args: {} })
        assert.equal(inventory.ok, true, JSON.stringify(inventory.error))
        const local = inventory.value.entries.find(row => row.moduleName === '@deepseek-ai/dsh-userdoc-local')
        const managed = inventory.value.entries.find(row => row.moduleName === '@deepseek-ai/dsh-userdoc-gateway')
        assert.equal(local.enabled, false); assert.equal(local.fiberPhase, null)
        assert.equal(managed.enabled, true); assert.equal(managed.fiberPhase, 'active')
        transcript.push(`${scope}: managed documents activate without opening a local provider.`)
        const documents = await fetch(runtimeUrl('/api/documents'), { headers: { cookie } })
        assert.equal(documents.status, 200, await documents.clone().text())
        const listing = await documents.json()
        assert.ok(listing.documents.some(row => row.docId === 'provider.txt'))
        const content = await fetch(runtimeUrl('/api/documents/content?id=provider.txt'), { headers: { cookie } })
        assert.equal(content.status, 200); assert.equal(await content.text(), 'managed document bytes')
        const anonymous = await fetch(runtimeUrl('/api/documents/content?id=provider.txt'), { redirect: 'manual' })
        assert.equal(anonymous.status, 401); await anonymous.arrayBuffer()
        const after = await active.command('status')
        assert.equal(after.generation, before.generation); assert.equal(after.admittedStarts, before.admittedStarts)
        transcript.push(`${scope}: signed document listing and bytes use the Gateway broker; anonymous access is refused.`)
        continue
      }
      const listing = await directoryRpc('host.listDirectory', {})
      if (directoryCase === 'empty') {
        assert.equal(listing.ok, false)
        assert.equal(listing.error.code, 'directory-unreadable')
        transcript.push(`${scope}: an empty Runtime grant set refuses directory browsing without host-home fallback.`)
      } else {
        assert.equal(listing.ok, true, JSON.stringify(listing.error))
        assert.ok(Array.isArray(listing.value.entries))
        transcript.push(`${scope}: the loopback Gateway Runtime serves authorized browser directory selection without a native dialog.`)
      }
      if (directoryCase === 'replacement') {
        const owned = active.ready.projectPath, foreign = active.ready.foreignHomePath, retained = join(root, 'retained-project-directory')
        assert.equal(typeof foreign, 'string')
        const readable = await directoryRpc('host.listDirectory', { path: owned })
        assert.equal(readable.ok, true)
        assert.ok(readable.value.entries.some(entry => entry.name === 'permitted-owned'))
        const created = await directoryRpc('host.createDirectory', { path: owned, name: 'permitted-created' })
        assert.equal(created.ok, true); assert.ok((await stat(join(owned, 'permitted-created'))).isDirectory())
        transcript.push(`${scope}: an ordinary member lists and creates directories under the granted project root.`)
        const outside = await directoryRpc('host.listDirectory', { path: foreign })
        assert.equal(outside.ok, false)
        assert.equal(outside.error.code, scope === 'personal' ? 'directory-unreadable' : 'collaboration-forbidden', `${scope} foreign-path authority`)
        transcript.push(`${scope}: another account's personal directory is refused before replacement.`)
        await rename(owned, retained)
        let substituted = false
        try {
          await rename(foreign, owned); substituted = true
          const listing = await directoryRpc('host.listDirectory', { path: owned })
          assert.equal(listing.ok, false); assert.equal(listing.error.code, 'directory-unreadable')
          const writing = await directoryRpc('host.createDirectory', { path: owned, name: 'unauthorized' })
          assert.equal(writing.ok, false); assert.equal(writing.error.code, 'directory-create-failed')
          await assert.rejects(stat(join(owned, 'unauthorized')), { code: 'ENOENT' })
          await assert.rejects(stat(join(retained, 'unauthorized')), { code: 'ENOENT' })
          assert.ok((await stat(join(owned, 'private-other-account'))).isDirectory())
          transcript.push(`${scope}: replacing the granted path with another account's directory refuses both listing and creation.`)
        } finally {
          if (substituted) await rename(owned, foreign)
          await rename(retained, owned)
        }
        const restored = await directoryRpc('host.listDirectory', { path: owned })
        assert.equal(restored.ok, true)
        assert.ok(restored.value.entries.some(entry => entry.name === 'permitted-created'))
        const current = await active.command('status')
        assert.equal(current.generation, before.generation); assert.equal(current.admittedStarts, before.admittedStarts)
        transcript.push(`${scope}: restoring the original object preserves valid browsing and the exact Runtime generation.`)
        continue
      }
      if (directoryCase !== undefined) {
        const denied = await directoryRpc('host.createDirectory', { path: directoryCase === 'readonly' ? active.ready.projectPath : root, name: 'unauthorized' })
        assert.equal(denied.ok, false)
        await assert.rejects(stat(join(directoryCase === 'readonly' ? active.ready.projectPath : root, 'unauthorized')), { code: 'ENOENT' })
        if (directoryCase === 'readonly' && scope === 'personal') {
          assert.equal(denied.error.code, 'directory-create-failed')
          assert.match(denied.error.message, /read-only/u)
          const created = await directoryRpc('host.createDirectory', { path: active.ready.homePath, name: 'permitted' })
          assert.equal(created.ok, true)
          assert.equal(created.value.path, join(active.ready.homePath, 'permitted'))
        }
        if (directoryCase === 'readonly') {
          const environment = JSON.parse(await readFile(join(active.ready.dshHome, 'environment-witness.json'), 'utf8'))
          assert.equal(environment.grants, join(active.ready.dshHome, 'directory-grants.json'))
        }
        transcript.push(`${scope}: unauthorized directory creation is refused before a filesystem change.`)
        continue
      }
      const exit = once(active.child, 'exit'); active.child.kill('SIGKILL'); await exit
      publicRelay.publish(undefined); intakeRelay.publish(undefined)
      const direct = await fetch(`http://127.0.0.1:${runtimePort}/`); await direct.arrayBuffer()
      assert.notEqual(direct.status, 500)
      active = await startGateway()
      const recovered = await active.command('status')
      assert.equal(recovered.state, 'ready'); assert.equal(recovered.generation, before.generation)
      const resumed = await fetch(runtimeUrl('/'), { headers: { cookie } }); assert.equal(resumed.status, 200); await resumed.arrayBuffer()
      const after = await active.command('status'); assert.equal(after.generation, before.generation); assert.equal(after.admittedStarts, before.admittedStarts)
      transcript.push(`${scope}: replacement Gateway reuses the exact generation without another cold-start credit.`)
      if (scope === 'project') {
        const peerCookie = await select(await login('peer'))
        const peerPage = await fetch(runtimeUrl('/'), { headers: { cookie: peerCookie } }); assert.equal(peerPage.status, 200); await peerPage.arrayBuffer()
        assert.equal((await active.command('status')).generation, before.generation)
        transcript.push('project: a second member shares the recovered project Runtime.')
      }
      const ownerDirectory = join(root, 'state', 'local-runtime-supervisors')
      const ownerFiles = (await readdir(ownerDirectory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      assert.equal(ownerFiles.length, 1)
      const ownerPath = join(ownerDirectory, ownerFiles[0]), ownerBytes = await readFile(ownerPath)
      try {
        const owner = JSON.parse(ownerBytes.toString('utf8'))
        assert.equal(owner.phase, 'running'); assert.equal(owner.identity.generation, before.generation)
        await writeFile(ownerPath, JSON.stringify({ ...owner, url: 'http://127.0.0.1:0/' }) + '\n')
        const unavailable = await fetch(runtimeUrl('/'), { headers: { cookie } })
        assert.equal(unavailable.status, 503)
        assert.equal((await unavailable.json()).error.code, 'INSTANCE_UNAVAILABLE')
        assert.deepEqual(await active.command('reuse-runtime'), { kind: 'reuse-runtime', code: 'INSTANCE_UNAVAILABLE', reason: 'unavailable' })
        const occupied = await active.command('status')
        assert.equal(occupied.resident, 1); assert.equal(occupied.generation, before.generation)
        assert.equal(occupied.admittedStarts, before.admittedStarts)
      } finally { await writeFile(ownerPath, ownerBytes) }
      const reachable = await fetch(runtimeUrl('/'), { headers: { cookie } })
      assert.equal(reachable.status, 200); await reachable.arrayBuffer()
      assert.equal((await active.command('status')).generation, before.generation)
      transcript.push(`${scope}: unavailable supervision returns 503, retains occupation, and resumes the same generation.`)
      if (directoryCase === undefined && documentCase === undefined) {
        await active.command('stop-runtime')
        const stoppedPage = await fetch(runtimeUrl('/'), { headers: { cookie, accept: 'text/html' } })
        assert.equal(stoppedPage.status, 200)
        const html = await stoppedPage.text()
        assert.ok(html.includes('启动并打开'))
        const action = new URL(html.match(/<form method="post" action="([^"]+)">/u)?.[1] ?? '', base)
        assert.equal(action.searchParams.get('dshRuntime'), active.ready.runtimeId)
        const body = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)]
          .map(match => [match[1], match[2]]))
        assert.equal(body.get('kind'), scope)
        if (scope === 'project') assert.equal(body.get('projectId'), String(active.ready.projectId))
        const restarted = await fetch(action, { method: 'POST', redirect: 'manual',
          headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body })
        await restarted.arrayBuffer()
        assert.equal(restarted.status, 302)
        assert.equal(new URL(restarted.headers.get('location'), base).searchParams.get('dshRuntime'), active.ready.runtimeId)
        const next = await active.command('status')
        assert.equal(next.state, 'ready'); assert.equal(next.generation, before.generation + 1)
        assert.equal(next.admittedStarts, before.admittedStarts + 1)
        transcript.push(`${scope}: the stopped page retains the exact Runtime through authorized restart and redirect.`)
      }
      const pendingTunnel = prepareShutdownTunnel === undefined ? undefined : await prepareShutdownTunnel()
      const stopped = once(active.child, 'exit'); await active.command('stop'); await stopped
      if (pendingTunnel !== undefined) {
        const outcome = await pendingTunnel.request
        if (outcome.status !== undefined) assert.equal(outcome.status, 503)
        else assert.ok(outcome.error instanceof TypeError)
        await assertConnectorClosed(pendingTunnel.prepared)
        transcript.push('tunnel: Gateway shutdown cancels pending registration and confirms connector closure.')
      }
      const row = (await pool.query(`SELECT observed_state FROM harness.instances WHERE organization_id=$1
        AND ${scope === 'personal' ? 'user_id' : 'project_id'} IS NOT NULL ORDER BY generation DESC LIMIT 1`, [organization])).rows[0]
      assert.equal(row.observed_state, 'stopped')
      transcript.push(`${scope}: graceful replacement shutdown confirms process exit and durable stop.`)
      active = undefined
    } finally {
      const errors = []
      if (active?.child.connected) {
        try { const exited = once(active.child, 'exit'); await active.command('stop'); await exited } catch (error) { errors.push(error) }
      }
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
      const directory = join(root, 'state', 'local-runtime-supervisors')
      try {
        let names
        try { names = await readdir(directory) } catch (error) { if (error.code !== 'ENOENT') throw error; names = [] }
        for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
          const record = JSON.parse(await readFile(join(directory, name), 'utf8'))
          await new LocalRuntimeControl(new LocalRuntimeOwnerStore(directory, record.identity), 30000).terminate(0)
        }
      } catch (error) { errors.push(error) }
      for (const entry of relays.reverse()) await entry.close()
      if (errors.length) throw new AggregateError(errors, `Web assembly cleanup retained its evidence in ${root}`)
      await removeOrganization(organization); await rm(root, { recursive: true, force: true })
    }
  }
  const actual = transcript.join('\n') + '\n'
  const expected = documentCase === undefined
    ? directoryCase === undefined ? 'local-runtime-web-assembly' : `directory-${directoryCase}-web-assembly`
    : 'managed-document-web-assembly'
  assert.equal(actual, await readFile(new URL(`./expected/${expected}.expected.md`, import.meta.url), 'utf8'))
  process.stdout.write(actual)
} finally { await pool.end() }
