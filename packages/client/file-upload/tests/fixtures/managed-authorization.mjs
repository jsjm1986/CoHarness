/** A real managed Host receives signed uploads while PostgreSQL owns conversation permissions. */
import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scheduler } from 'node:timers/promises'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const root = new URL('../../../../../', import.meta.url)
const entry = path => path === 'client/file-upload' && artifactRoot !== undefined
  ? pathToFileURL(resolve(artifactRoot, mode === 'src' ? 'src/index.ts' : 'lib/index.js')).href
  : new URL(`packages/${path}/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root).href
const { createPostgresPool, runMigrations } = await import(new URL('gateway/src/postgres/database.ts', root))
const { createExecutionFixture } = await import(new URL('gateway/tests/execution-fixture.ts', root))
const { PostgresCollaborationService } = await import(new URL('gateway/src/postgres/collaboration-service.ts', root))
const { postgresTestDatabaseUrl } = await import(new URL('gateway/tests/postgres-test-database.mjs', root))
const { boot } = await import(entry('boot/app-boot'))
const { SessionId } = await import(entry('core/session'))
const pool = createPostgresPool(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL), { max: 8 })
let f, ctx, primaryError
const handles = []
const incoming = []
const only = process.env.DSH_FILE_UPLOAD_PROBE
async function waitFor(predicate) {
  const deadline = performance.now() + 10_000
  do {
    if (await predicate()) return
    await scheduler.yield()
  } while (performance.now() < deadline)
  throw new Error('Managed upload did not reach its owned filesystem state')
}
try {
  await runMigrations(pool, fileURLToPath(new URL('gateway/deploy/postgres/migrations', root)))
  f = await createExecutionFixture(pool)
  const credential = join(process.cwd(), 'credential.json')
  await writeFile(credential, JSON.stringify({ version: 1, gatewayUrl: f.base, organization: f.context.organizationSlug,
    runtime: { kind: 'project', id: f.project.id, generation: f.project.generation, runtimeId: f.project.runtimeId },
    token: f.project.token, principalPublicKey: f.publicKey,
  }), { mode: 0o600 })
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credential
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD
  const home = join(process.cwd(), '.dsh'), config = join(process.cwd(), 'cordis.yml')
  await mkdir(home, { recursive: true })
  const plugins = [
    ['credentials/credentials-local', { path: join(home, 'credentials.yaml'), dshHome: home, watch: false }],
    ['host/webserver', { host: '127.0.0.1', port: 0 }], ['client/connection'],
    ['context/gateway-runtime'], ['context/collaboration-gateway'],
    ['core/session'], ['llm/llm'], ['core/system-prompt'], ['core/tools'], ['core/agent'],
    ['session/session-projection'], ['core/agent-loop', { agents: [] }],
    ['interaction/commands'], ['attachment/attachment-local', { dshHome: home }], ['client/file-upload'],
  ]
  await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({ name: entry(path),
    ...options === undefined ? {} : { config: options },
  }))))
  ctx = await boot('managed-file-upload-authorization', config)
  const upload = async (sessionId, person) => {
    const response = await fetch(`${ctx.webServer.getOrigin()}/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=proof.txt`, {
      method: 'POST', headers: { ...f.headers(f.project, person), 'content-type': 'application/octet-stream' }, body: 'proof',
      signal: AbortSignal.timeout(10_000),
    })
    return { status: response.status, body: await response.json() }
  }
  const collaboration = new PostgresCollaborationService(f.context)
  if (only === undefined) {
    const { Context } = await import('@deepseek-ai/cordis')
    const clientRoot = new Context()
    const clientEntry = path => new URL(`packages/${path}/${mode === 'src' ? 'src/client/index.ts' : 'lib/client.js'}`, root).href
    const { installConnection, clientSessionKey } = await import(clientEntry('client/connection'))
    const { apply } = await import(clientEntry('client/file-upload'))
    const origin = ctx.webServer.getOrigin()
    installConnection(clientRoot, { location: { hostname: '127.0.0.1', origin, search: '' } })
    const connection = clientRoot.get('connection')
    assert.ok(connection)
    connection.confirmPrincipal(f.admin.id)
    connection.setBaseTarget({ kind: 'personal' })
    const id = await f.session(), handle = await ctx.agents.create({ sessionId: SessionId(id) })
    handles.push(handle)
    const key = clientSessionKey({ kind: 'project', projectId: f.project.id, runtimeId: f.project.runtimeId }, SessionId(id))
    const previous = globalThis.__DSH_FILE_UPLOAD__
    let addressed = 0
    globalThis.__DSH_FILE_UPLOAD__ = { fetch: async (path, init) => {
      const url = new URL(path, origin)
      assert.equal(url.searchParams.get('dshRuntime'), f.project.runtimeId)
      assert.equal(url.searchParams.get('dshTarget'), `project:${f.project.id}`)
      assert.equal(url.searchParams.get('dshPrincipal'), String(f.admin.id))
      assert.equal(url.searchParams.get('sessionId'), id)
      addressed += 1
      return fetch(url, { ...init, headers: { ...f.headers(f.project, f.admin), ...init.headers } })
    } }
    try {
      await clientRoot.plugin({ apply }).await()
      for (const body of [new Blob(['scoped']), new ReadableStream({ start(c) { c.enqueue(Buffer.from('scoped')); c.close() } })]) {
        const result = await clientRoot.fileUpload.upload(key, body, 'scoped.txt', AbortSignal.timeout(10000))
        assert.equal(result.ok, true)
        const chunks = []
        for await (const chunk of ctx.attachments.readFileStream(result.value.file)) chunks.push(Buffer.from(chunk))
        assert.equal(Buffer.concat(chunks).toString(), 'scoped')
        assert.equal(ctx.fileUploads.resolve(handle.agent, result.value.receiptId).bytes, 6)
      }
      console.log(JSON.stringify({ scenario: 'runtime-qualified-browser', addressed, originalSessionVerified: true,
        distinctBootstrapRetained: true, bytesVerified: true, signedManagedHost: true }))
    } finally {
      if (previous === undefined) delete globalThis.__DSH_FILE_UPLOAD__
      else globalThis.__DSH_FILE_UPLOAD__ = previous
      await clientRoot.fiber.dispose()
    }
  }
  for (const restriction of only === undefined ? ['private', 'read-only'] : []) {
    const id = await f.session(), handle = await ctx.agents.create({ sessionId: SessionId(id) })
    handles.push(handle)
    if (restriction === 'private') await collaboration.setVisibility(f.admin.id, f.project.runtimeId, id, 'private')
    else await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",
      [f.organizationId, f.project.uuid, f.member.uuid])
    const permission = await f.call('/internal/runtime/collaboration/authorize', { sessionId: id, action: 'write' }, f.member)
    assert.equal(permission.status, 403)
    const allowed = await upload(id, f.admin)
    assert.equal(allowed.status, 200); assert.equal(allowed.body.ok, true)
    const chunks = []
    for await (const chunk of ctx.attachments.readFileStream(allowed.body.value.file)) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), 'proof')
    const denied = await upload(id, f.member)
    console.log(JSON.stringify({ restriction, independentPermissionDenied: permission.status === 403,
      ownerUploadAccepted: allowed.body.ok, ownerBytesVerified: true, peerUploadAccepted: denied.body.ok,
      refusal: denied.body.error?.code ?? null }))
    assert.equal(denied.status, 200)
    assert.equal(denied.body.ok, false, 'Raw upload bypassed the Session write permission')
    assert.equal(denied.body.error.code, 'collaboration-forbidden')
  }
  const staging = join(home, 'attachments', 'v1', 'tmp')
  await mkdir(staging, { recursive: true })
  for (const scenario of only === undefined ? ['streamed', 'revoked', 'cancelled', 'service']
    : [only === 'service-withdrawal' ? 'service' : only]) {
    await pool.query("UPDATE harness.project_members SET access_mode='rw' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",
      [f.organizationId, f.project.uuid, f.member.uuid])
    const id = await f.session(), handle = await ctx.agents.create({ sessionId: SessionId(id) })
    handles.push(handle)
    const upload = request(`${ctx.webServer.getOrigin()}/api/session/uploadFileBinary?sessionId=${id}&name=streamed.txt`, {
      method: 'POST', headers: { ...f.headers(f.project, f.member), 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(15_000),
    })
    const closed = new Promise(ready => { upload.once('close', ready) })
    const outcome = new Promise(ready => {
      upload.once('error', error => { ready({ error: error.code ?? error.name }) })
      upload.once('response', response => {
        const chunks = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.once('error', error => ready({ error: error.code ?? error.name }))
        response.once('end', () => ready({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
    })
    incoming.push({ upload, closed, outcome })
    try {
      upload.write('first')
      await waitFor(async () => (await readdir(staging)).length === 1)
      const idleDisposal = only === 'service-withdrawal' ? null : await handle.tryDisposeIdle()
      console.log(JSON.stringify({ scenario, phase: 'streaming', idleDisposal }))
      if (only !== 'service-withdrawal') assert.equal(idleDisposal, false, 'An active upload lost its exact Agent to idle disposal')
      if (scenario === 'revoked') await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE organization_id=$1 AND project_id=$2 AND user_id=$3",
        [f.organizationId, f.project.uuid, f.member.uuid])
      if (scenario === 'service') {
        const mounted = [...ctx.loader.entries()].find(row => row.options.name === entry('client/file-upload'))
        assert.ok(mounted?.fiber)
        await mounted.fiber.dispose()
        const stagingFiles = (await readdir(staging)).length
        console.log(JSON.stringify({ scenario, phase: 'withdrawn', stagingFiles }))
        assert.equal(stagingFiles, 0, 'Service withdrawal returned before cleaning its active upload')
      } else if (scenario === 'cancelled') upload.destroy(new Error('Fixture caller cancelled'))
      else upload.end('last')
      const result = await outcome
      await closed
      if (scenario === 'cancelled') await waitFor(async () => (await readdir(staging)).length === 0)
      const stagingFiles = (await readdir(staging)).length
      assert.equal(stagingFiles, 0, 'Retired upload left a live temporary file')
      if (scenario === 'streamed') {
        assert.equal(result.body.ok, true)
        assert.equal(ctx.fileUploads.resolve(handle.agent, result.body.value.receiptId).bytes, 9)
      } else if (scenario === 'revoked') {
        assert.equal(result.body.ok, false)
        assert.equal(result.body.error.code, 'collaboration-forbidden')
      } else assert.ok(result.error)
      console.log(JSON.stringify({ scenario, phase: 'settled', accepted: result.body?.ok ?? false,
        refusal: result.body?.error?.code ?? null, disconnected: result.error !== undefined, stagingFiles }))
    } finally {
      upload.destroy(new Error('Fixture request cleanup'))
      await closed
      await outcome
    }
  }
} catch (error) { primaryError = error; throw error }
finally {
  const errors = []
  for (const { upload, closed, outcome } of incoming) { upload.destroy(new Error('Fixture request cleanup')); await closed; await outcome }
  for (const handle of handles.reverse()) { try { await handle.dispose() } catch (error) { errors.push(error) } }
  for (const close of [() => ctx?.fiber.dispose(), () => f?.dispose(), () => pool.end()]) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Managed upload fixture cleanup failed')
}
